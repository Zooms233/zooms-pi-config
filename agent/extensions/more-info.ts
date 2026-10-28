/**
 * more-info.ts — 接管 footer，在第一行右侧（模型名正上方）显示实时输出统计
 *
 * 布局复刻 pi 官方 FooterComponent（packages/coding-agent/src/modes/interactive/components/footer.ts）：
 *   行1: pwd (branch) • sessionName          TTFT 0.01s · ⚡41 tok/s · 1.3s   ← more-info 右对齐
 *   行2: ↑in ↓out R... W... CH..% $cost p%/win (auto)              model • level
 *
 * 计时与速率（纯本地，不额外请求 LLM）：
 * - 墙钟 = 整个 agent 任务（agent_start → agent_end），含中间工具调用 → 尾部的「x.xs / 总 x.xs」
 * - TTFT = 本轮请求发出（turn_start / before_provider_request）→ 第一个 delta，逐轮独立
 * - ⚡ tok/s = 2s 滑窗速率（EMA 平滑）。分母只累计「有效流式时长 streamMs」：
 *   delta 间隔 > 500ms 视为 burst 边界（工具执行 / 网络停顿 / 重试 / 消息间隙），
 *   既不计入 streamMs 也会清空滑窗 → 工具执行期间速率冻结，不被非输出时间稀释
 * - token 数自动选源：provider 流式中连续回传 usage（如 Anthropic 的 message_delta）→ 用真值；
 *   只在末块回传（openai-completions）→ 用 chars / charsPerToken 估算，并在每条 message_end
 *   用真实 usage.output 反向校准 charsPerToken（EMA，clamp 1.2~6.0）
 * - 结束后 ⚡ 定格为 outputTokens / streamMs，与流式中同口径，收尾不跳变
 * - agent_end 漏触发（abort 等）时，250ms 定时器用 ctx.isIdle() 兜底定格
 * - 行2 统计与 getContextUsage 结果按 leaf 缓存（两者原本每帧全量扫描/重建 projection）
 *
 * 已知近似：autoCompact 开关无扩展 API，固定显示 (auto)（pi 默认开启）。
 * 不注入上下文、不发起 LLM 请求、不写 session 条目。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total?: number };
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

// ---- 速率统计参数（可调）----
const BURST_GAP_MS = 500; // delta 间隔超过此值视为非流式（工具/停顿/重试），排除并重启滑窗
const WINDOW_MS = 2000; // 滑窗长度（平稳优先）
const SAMPLE_MS = 100; // 采样限流
const MAX_SAMPLES = 30;
const MIN_WINDOW_MS = 800; // 出数所需的最小窗口跨度
const MIN_WINDOW_TOK = 4; // 出数所需的最小 token 增量
const EMA_ALPHA = 0.3; // 速率平滑系数
const CAL_ALPHA = 0.3; // charsPerToken 校准系数
const MIN_CPT = 1.2;
const MAX_CPT = 6.0;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!isInsideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

export default function (pi: ExtensionAPI) {
	// ---- more-info 实时统计状态 ----
	// 任务级
	let start = 0; // agent 任务开始时刻 (ms)，墙钟含工具调用
	let elapsed = 0; // 定格的总用时 (ms)，0 = 任务进行中
	let ttft = 0; // 最近一条 assistant 消息的首 token 延迟 (ms)
	let requestStart = 0; // 本轮 LLM 请求发出时刻 (ms)，TTFT 起算点
	let lastPaint = 0; // 上次重绘时刻（节流）
	let tickTimer: ReturnType<typeof setInterval> | null = null;
	// 速率级（流式中）
	let chars = 0; // 当前这条 assistant 消息累计输出字符数（估算用）
	let outputTokens = 0; // 本次 agent 任务累计真实输出 tokens
	let tps = 0; // 结束后定格的速率：outputTokens / streamMs
	let streamMs = 0; // 有效流式时长累计（tok/s 的分母，不含工具时间）
	let rate = 0; // 滑窗 EMA 后的显示速率
	let samples: Array<[number, number]> = []; // [时刻, token 数]
	let lastDeltaAt = 0;
	let lastSampleAt = 0;
	let charsPerToken = 3.6; // 中英混合初值，随 message_end 真实 usage 自校准
	let msgTok0 = 0; // 本条消息开始时的 usage.output 基线
	let usageBumps = 0; // 本条消息内流式 usage 增长次数（≥2 判定 provider 实时回传）
	let lastRealOutput = 0;
	// footer 会话状态与统计缓存
	let model: any;
	let thinkingLevel: any;
	let tui: { requestRender(): void } | null = null;
	let ctxRef: any = null;
	let footerRegistered = false;
	let statsCache:
		| { key: string; totals: Totals; latestCacheHitRate: number | undefined; cu: any }
		| null = null;

	function syncState(ctx: any) {
		if (ctx) ctxRef = ctx;
		if (ctx?.model) model = ctx.model;
		if (ctx?.thinkingLevel) thinkingLevel = ctx.thinkingLevel;
	}

	function resetTiming() {
		chars = 0;
		start = 0;
		requestStart = 0;
		ttft = 0;
		tps = 0;
		elapsed = 0;
		outputTokens = 0;
		lastPaint = 0;
		rate = 0;
		streamMs = 0;
		samples = [];
		lastDeltaAt = 0;
		lastSampleAt = 0;
		usageBumps = 0;
		lastRealOutput = 0;
		msgTok0 = 0;
	}

	function resetMessageSampling() {
		chars = 0;
		samples = [];
		lastDeltaAt = 0; // 首 delta 不计入 streamMs → TTFT 段天然排除
		lastSampleAt = 0;
		usageBumps = 0;
		lastRealOutput = 0;
		// rate 不重置：跨消息保留 EMA 速率，显示连续
	}

	function repaint() {
		const now = Date.now();
		if (now - lastPaint > 100) {
			lastPaint = now;
			tui?.requestRender();
		}
	}

	// 当前累计输出 tokens：provider 流式中连续回传 usage → 真值；否则字符估算
	function currentTokens(): number {
		if (usageBumps >= 2 && lastRealOutput > msgTok0) return lastRealOutput;
		return chars / charsPerToken;
	}

	// 用滑窗首尾样本求瞬时速率并 EMA 平滑；窗口不足则保持原值（工具执行期间冻结）
	function updateRate() {
		if (samples.length < 3) return;
		const [t0, k0] = samples[0];
		const [t1, k1] = samples[samples.length - 1];
		const span = t1 - t0;
		const dTok = k1 - k0;
		if (span < MIN_WINDOW_MS || dTok < MIN_WINDOW_TOK) return;
		const inst = (dTok * 1000) / span;
		rate = rate > 0 ? rate * (1 - EMA_ALPHA) + inst * EMA_ALPHA : inst;
	}

	// 定格任务计时：agent_end 正常路径与 isIdle() 兜底路径共用
	function finalizeTask(totalOutput?: number) {
		if (!start || elapsed) return;
		elapsed = Date.now() - start;
		const out = totalOutput && totalOutput > 0 ? totalOutput : outputTokens;
		// 与流式中同口径：分母只用有效流式时长，工具时间不掺入 → 收尾不跳变
		if (out > 0 && streamMs > MIN_WINDOW_MS) tps = out / (streamMs / 1000);
		lastPaint = 0;
		repaint();
	}

	// more-info 文本（无色，着色由 render 统一处理）
	// 流式中：TTFT · ⚡滑窗速率 · 跳动秒数；结束后：⚡定格速率 · TTFT · 总用时
	function moreInfoText(): string {
		if (!start) return "";
		const parts: string[] = [];
		const shownRate = elapsed > 0 ? tps : rate;
		if (ttft > 0) parts.push(`TTFT ${(ttft / 1000).toFixed(2)}s`);
		if (shownRate > 0) parts.push(`⚡${shownRate.toFixed(0)} tok/s`);
		parts.push(
			elapsed > 0
				? `总 ${(elapsed / 1000).toFixed(1)}s`
				: `${((Date.now() - start) / 1000).toFixed(1)}s`,
		);
		return parts.join(" · ");
	}

	pi.on("session_start", async (_event, ctx: any) => {
		syncState(ctx);
		resetTiming();
		statsCache = null;

		// 工具执行期间无流式事件，用定时器驱动秒数跳动 + 速率滑窗老化 + isIdle 兜底
		if (!tickTimer) {
			tickTimer = setInterval(() => {
				if (!start || elapsed) return;
				if (Date.now() - start > 1000 && ctxRef?.isIdle?.()) {
					finalizeTask(); // agent_end 漏触发（abort / 异常路径）时定格，避免秒数无限跳
					return;
				}
				if (lastDeltaAt && Date.now() - lastDeltaAt > BURST_GAP_MS) samples = [];
				tui?.requestRender();
			}, 250);
		}

		if (footerRegistered || !ctx.ui?.setFooter) return;
		footerRegistered = true;

		ctx.ui.setFooter((_t: any, theme: any, footerData: any) => {
			tui = _t;
			const unsub = footerData.onBranchChange?.(() => tui?.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// ===== 行1：pwd (branch) • sessionName … more-info 右对齐（模型名正上方）=====
					let pwd = formatCwdForFooter(process.cwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch?.();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = pi.getSessionName?.();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const minPadding = 2;
					const mi = moreInfoText();
					const miWidth = visibleWidth(mi);
					// 空间不足（pwd 会被压到 24 列以下）时隐藏 more-info，保官方行1 完整
					const showMi = mi !== "" && width - miWidth - minPadding >= 24;
					const dimPwd = truncateToWidth(
						theme.fg("dim", pwd),
						showMi ? width - miWidth - minPadding : width,
						theme.fg("dim", "..."),
					);
					const pwdLine = showMi
						? truncateToWidth(
								dimPwd +
									" ".repeat(Math.max(minPadding, width - visibleWidth(dimPwd) - miWidth)) +
									theme.fg("accent", mi),
								width,
							)
						: dimPwd;

					// ===== 行2 统计（复刻官方算法；结果按 leaf|model 缓存）=====
					// getEntries() 每次调用都复制整个 session，getContextUsage() 还会重建 projection，
					// 而 footer 每帧都 render（流式中最高 4Hz）→ 官方同款缓存：leaf 未移动即复用。
					const leafKey =
						typeof ctx.sessionManager.getLeafId === "function"
							? String(ctx.sessionManager.getLeafId())
							: null;
					const cacheKey = leafKey === null ? null : `${leafKey}|${model?.id ?? ""}`;
					let totals: Totals;
					let latestCacheHitRate: number | undefined;
					let cu: any;
					if (cacheKey !== null && statsCache && statsCache.key === cacheKey) {
						totals = statsCache.totals;
						latestCacheHitRate = statsCache.latestCacheHitRate;
						cu = statsCache.cu;
					} else {
						totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
						latestCacheHitRate = undefined;
						const acc = (u: Usage) => {
							totals.input += u.input || 0;
							totals.output += u.output || 0;
							totals.cacheRead += u.cacheRead || 0;
							totals.cacheWrite += u.cacheWrite || 0;
							totals.cost += u.cost?.total || 0;
						};

						for (const entry of ctx.sessionManager.getEntries()) {
							if (entry.type === "usage") {
								acc(entry.usage);
							} else if (entry.type === "message" && entry.message.role === "assistant") {
								acc(entry.message.usage);
								const prompt =
									entry.message.usage.input +
									entry.message.usage.cacheRead +
									entry.message.usage.cacheWrite;
								latestCacheHitRate =
									prompt > 0 ? (entry.message.usage.cacheRead / prompt) * 100 : undefined;
							} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
								acc(entry.message.usage);
							} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
								acc(entry.usage);
							}
						}
						cu = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
						if (cacheKey !== null) statsCache = { key: cacheKey, totals, latestCacheHitRate, cu };
					}

					const statsParts: string[] = [];
					if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);

					// 上下文占用（颜色随用量变化，同官方；cu 取自上面的缓存）
					const contextWindow = cu?.contextWindow ?? model?.contextWindow ?? 0;
					const percentValue = cu?.percent ?? 0;
					const percentStr = cu?.percent !== null && cu?.percent !== undefined ? percentValue.toFixed(1) : "?";
					const autoIndicator = " (auto)";
					const contextDisplay =
						percentStr === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${percentStr}%/${formatTokens(contextWindow)}${autoIndicator}`;
					statsParts.push(
						percentValue > 90
							? theme.fg("error", contextDisplay)
							: percentValue > 70
								? theme.fg("warning", contextDisplay)
								: contextDisplay,
					);

					let statsLeft = statsParts.join(" ");

					// 超宽时先截断统计段（同官方），再考虑右侧模型名
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// ===== 右侧：provider? model • thinkingLevel（复刻官方）=====
					let rightSideWithoutProvider = model?.id || "no-model";
					if (model?.reasoning) {
						const level = thinkingLevel || "off";
						rightSideWithoutProvider =
							level === "off" ? `${model.id} • thinking off` : `${model.id} • ${level}`;
					}
					let rightSide = rightSideWithoutProvider;
					const providerCount = footerData.getAvailableProviderCount?.() ?? 1;
					if (providerCount > 1 && model) {
						rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) rightSide = rightSideWithoutProvider;
					}

					// ===== 行2：统计 + 右对齐模型名（more-info 已移到行1）=====
					const rightWidth = visibleWidth(rightSide);
					let remainder: string;
					if (statsLeftWidth + minPadding + rightWidth <= width) {
						remainder = " ".repeat(Math.max(minPadding, width - statsLeftWidth - rightWidth)) + rightSide;
					} else {
						const avail = width - statsLeftWidth - minPadding;
						const rightShown = avail > 0 ? truncateToWidth(rightSide, avail, "") : "";
						remainder =
							" ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(rightShown))) + rightShown;
					}
					// 官方同款：statsLeft 内含 context% 的颜色（末尾带 reset），必须分段 dim
					const statsLine = theme.fg("dim", statsLeft) + theme.fg("dim", remainder);

					return [pwdLine, truncateToWidth(statsLine, width)];
				},
			};
		});
	});

	// 模型 / 思考级别切换
	pi.on("model_select", async (event: any, ctx: any) => {
		if (event?.model) model = event.model;
		syncState(ctx);
		tui?.requestRender();
	});
	pi.on("thinking_level_select", async (event: any, ctx: any) => {
		if (event?.thinkingLevel) thinkingLevel = event.thinkingLevel;
		syncState(ctx);
		tui?.requestRender();
	});

	// 计时起点：整个 agent 任务开始（含中间所有工具调用）
	pi.on("agent_start", async (_event: any, ctx: any) => {
		syncState(ctx);
		resetTiming();
		start = Date.now();
		repaint();
	});

	// TTFT 起算点：每轮 LLM 请求发出时刻（而非 agent 任务起点），逐轮独立
	pi.on("turn_start", async (_event: any, _ctx: any) => {
		requestStart = Date.now();
	});
	// before_provider_request 在 payload 构建完、紧贴发送前触发，比 turn_start 更精确，覆盖更新
	pi.on("before_provider_request", () => {
		requestStart = Date.now();
	});

	// 每条 assistant 消息开始：只重置消息级统计（TTFT/采样窗口），不动任务计时
	pi.on("message_start", async (event: any, ctx: any) => {
		syncState(ctx);
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		ttft = 0;
		tps = 0;
		resetMessageSampling();
		msgTok0 = msg.usage?.output || 0;
		if (!requestStart) requestStart = Date.now(); // 事件缺失时兜底：近似以 message_start 起算
		lastPaint = 0;
		repaint();
	});

	pi.on("message_update", async (event: any, _ctx: any) => {
		const ev = event.assistantMessageEvent;
		if (!ev) return;
		if (
			ev.type === "text_delta" ||
			ev.type === "thinking_delta" ||
			ev.type === "toolcall_delta"
		) {
			const now = Date.now();
			if (!start) start = now; // 惰性兜底
			if (!ttft) ttft = now - (requestStart || start);

			// 有效流式时长：只累计 ≤ BURST_GAP 的间隔；更大间隔是工具/停顿/重试 → 排除并重启滑窗
			if (lastDeltaAt) {
				const gap = now - lastDeltaAt;
				if (gap > BURST_GAP_MS) samples = [];
				else streamMs += gap;
			}
			lastDeltaAt = now;

			chars += ev.delta.length;
			// partial 是 provider 原地 mutate 的同一 AssistantMessage 对象，流式中可读
			const real = ev.partial?.usage?.output ?? 0;
			if (real > msgTok0) {
				usageBumps++;
				lastRealOutput = real;
				if (usageBumps === 2) samples = []; // 估算→真值切换：丢弃旧样本，避免口径不连续污染速率
			}
			if (now - lastSampleAt >= SAMPLE_MS) {
				lastSampleAt = now;
				samples.push([now, currentTokens()]);
				if (samples.length > MAX_SAMPLES) samples.shift();
				while (samples.length > 2 && now - samples[0][0] > WINDOW_MS) samples.shift();
				updateRate();
			}
			repaint(); // 100ms 节流重绘 → 秒数与速率持续跳动
		}
	});

	// 每条 assistant 消息结束：累计真实 output tokens，并用它反向校准 charsPerToken
	pi.on("message_end", async (event: any, _ctx: any) => {
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		const out = msg.usage?.output || 0;
		outputTokens += out;
		if (out > 0 && chars > 0) {
			const observed = chars / out;
			if (observed >= MIN_CPT && observed <= MAX_CPT) {
				charsPerToken = charsPerToken * (1 - CAL_ALPHA) + observed * CAL_ALPHA;
			}
		}
		lastPaint = 0;
		repaint();
	});

	// agent 停止任务：定格墙钟，并用真实 output tokens / 有效流式时长定格速率
	pi.on("agent_end", async (event: any, _ctx: any) => {
		if (!start) return;
		// 官方 tps.ts 同款算法：agent_end 的 messages 里累加 output 作为权威总数
		let total = 0;
		for (const m of event?.messages ?? []) {
			if ((m as any)?.role === "assistant") total += (m as any).usage?.output || 0;
		}
		finalizeTask(total);
	});

	pi.on("session_shutdown", async () => {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	});
}
