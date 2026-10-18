/**
 * more-info.ts — 接管 footer，在统计行（↑23k ↓5.3k … 那一行）同行追加实时输出统计
 *
 * 布局复刻 pi 官方 FooterComponent（packages/coding-agent/src/modes/interactive/components/footer.ts）：
 *   行1: pwd (branch) • sessionName
 *   行2: ↑in ↓out R... W... CH..% $cost p%/win (auto)  ⚡ 22 tok/s · TTFT 0.01s · 1.3s   model • level
 *
 * 统计逻辑（纯本地）：
 * - 计时范围 = 整个 agent 任务（agent_start → agent_end），包含中间的工具调用
 * - 工具执行期间无流式事件，用 250ms 定时器驱动重绘，秒数持续跳动
 * - 结束后用 agent_end 的 messages 累计真实 output tokens 校准 tok/s，定格「总 x.xs」
 * - TTFT = 本轮 LLM 请求发出（turn_start / before_provider_request）→ 第一个 delta，逐轮独立计算
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
	let chars = 0; // 当前这条 assistant 消息累计输出字符数
	let start = 0; // agent 任务开始时刻 (ms)，整个任务含工具调用
	let ttft = 0; // 最近一条 assistant 消息的首 token 延迟 (ms)
	let requestStart = 0; // 本轮 LLM 请求发出时刻 (ms)，TTFT 起算点
	let tps = 0; // 结束后显示的真实速率
	let elapsed = 0; // agent_end 定格的总用时 (ms)，0 = 任务进行中
	let outputTokens = 0; // 本次 agent 任务累计真实输出 tokens
	let lastPaint = 0; // 上次重绘时刻（节流）
	let tickTimer: ReturnType<typeof setInterval> | null = null;

	// ---- footer 需要的会话状态（事件驱动更新）----
	let model: any;
	let thinkingLevel: any;
	let tui: { requestRender(): void } | null = null;
	let footerRegistered = false;

	function syncState(ctx: any) {
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
	}

	function repaint() {
		const now = Date.now();
		if (now - lastPaint > 100) {
			lastPaint = now;
			tui?.requestRender();
		}
	}

	// more-info 文本（无色，着色由 render 统一处理）
	// 流式中：TTFT + 持续跳动的秒数（tok/s 为估算值不显示）；结束后：真实校准的 ⚡ tok/s + 总用时
	function moreInfoText(): string {
		if (!start) return "";
		const parts: string[] = [];
		if (elapsed > 0) {
			if (tps > 0) parts.push(`⚡ ${tps.toFixed(0)} tok/s`);
			if (ttft > 0) parts.push(`TTFT ${(ttft / 1000).toFixed(2)}s`);
			parts.push(`总 ${(elapsed / 1000).toFixed(1)}s`);
		} else {
			if (ttft > 0) parts.push(`TTFT ${(ttft / 1000).toFixed(2)}s`);
			parts.push(`${((Date.now() - start) / 1000).toFixed(1)}s`);
		}
		return parts.join(" · ");
	}

	pi.on("session_start", async (_event, ctx: any) => {
		syncState(ctx);
		resetTiming();

		// 工具执行期间无流式事件，用定时器驱动秒数持续跳动（仅在任务进行中重绘）
		if (!tickTimer) {
			tickTimer = setInterval(() => {
				if (start && !elapsed) tui?.requestRender();
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
					// ===== 行1：pwd (branch) • sessionName =====
					let pwd = formatCwdForFooter(process.cwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch?.();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = pi.getSessionName?.();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

					// ===== 行2 统计（复刻官方算法）=====
					const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					let latestCacheHitRate: number | undefined;
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

					const statsParts: string[] = [];
					if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);

					// 上下文占用（颜色随用量变化，同官方）
					const cu = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
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

					// 超宽时先截断统计段（同官方），再考虑右侧与 more-info
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

					// ===== more-info 追加段：位于统计与模型名之间 =====
					const minPadding = 2;
					const mi = moreInfoText();
					const miWithPad = mi ? `  ${mi}` : "";
					const miWidth = visibleWidth(miWithPad);
					const rightWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + miWidth + minPadding + rightWidth;

					let miShown = miWithPad;
					if (totalNeeded > width) {
						const avail = width - statsLeftWidth - minPadding - rightWidth;
						if (avail > 3) {
							miShown = truncateToWidth(miWithPad, Math.max(4, avail), "");
						} else {
							miShown = ""; // 放不下就先隐藏 more-info，保官方统计完整
						}
					}

					const padding = " ".repeat(
						Math.max(minPadding, width - statsLeftWidth - visibleWidth(miShown) - rightWidth),
					);

					const statsLine =
						theme.fg("dim", statsLeft) +
						theme.fg("accent", miShown) +
						theme.fg("dim", padding + rightSide);

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

	// 每条 assistant 消息开始：只重置消息级统计（TTFT/估算），不动任务计时
	pi.on("message_start", async (event: any, ctx: any) => {
		syncState(ctx);
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		chars = 0;
		ttft = 0;
		tps = 0;
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
			if (!start) start = Date.now(); // 惰性兜底
			if (!ttft) ttft = Date.now() - (requestStart || start);
			chars += ev.delta.length;
			repaint(); // 100ms 节流重绘 → 秒数持续跳动
		}
	});

	// 每条 assistant 消息结束：累计真实 output tokens（供结束后 tok/s），任务继续则不定格计时
	pi.on("message_end", async (event: any, _ctx: any) => {
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		outputTokens += msg.usage?.output || 0;
		lastPaint = 0;
		repaint();
	});

	// agent 停止任务：定格总用时，用累计真实 output tokens 校准 tok/s
	pi.on("agent_end", async (event: any, _ctx: any) => {
		if (!start) return;
		elapsed = Date.now() - start;
		// 官方 tps.ts 同款算法：agent_end 的 messages 里累加 output 兜底
		let total = 0;
		for (const m of event?.messages ?? []) {
			if ((m as any)?.role === "assistant") total += (m as any).usage?.output || 0;
		}
		const finalOutput = total > 0 ? total : outputTokens;
		if (finalOutput > 0 && elapsed > 300) {
			tps = finalOutput / (elapsed / 1000);
		}
		lastPaint = 0;
		repaint(); // 立即重绘，定格「总 x.xs」
	});

	pi.on("session_shutdown", async () => {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	});
}
