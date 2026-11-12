/**
 * more-info.ts — 接管 footer，第一行右侧（模型名正上方）显示实时输出统计
 *
 *   行1: pwd (branch) • sessionName          TTFT 0.01s · ⚡41 tok/s · 1.3s
 *   行2: ↑in ↓out R... CH..% p%/win (auto)        model • level
 *        p% = 上下文占用 / win = 上下文窗口
 *        W(cacheWrite)、$cost 仅当 provider 上报对应字段时出现（openai-completions 无 cacheWrite）
 *
 * - 墙钟 = agent 任务（agent_start → agent_end），含中间工具调用
 * - TTFT = 本轮请求发出 → 首个 delta，逐轮独立
 * - ⚡ tok/s = 2s 滑窗 EMA；分母只累有效流式时长（delta 间隔 >500ms 视为工具/停顿，排除）
 * - token 源：provider 流式回传 usage 用真值，否则 chars/charsPerToken 估算，message_end 校准
 * - 行2 统计与 getContextUsage 按 leaf 缓存（原本每帧全量扫描 / 重建 projection）
 * - (auto) 固定显示：autoCompact 开关无扩展 API
 *
 * 结构：顶部纯函数（格式化 / 会话统计 / 排版），工厂内 time 状态与 footer 组装。
 * 不注入上下文、不发起 LLM 请求、不写 session 条目。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---- 排版参数 ----
const MIN_PADDING = 2; // 两段之间的最小空隙
const MIN_PWD_WIDTH = 24; // pwd 被压到此宽度以下时隐藏 more-info
const PCT_WARN = 70; // 上下文占用告警阈值
const PCT_ERROR = 90;
const REPAINT_MS = 100; // 重绘节流
const TICK_MS = 250; // 无流式事件时的刷新周期（秒数跳动 / 滑窗老化）
const IDLE_GRACE_MS = 1000; // isIdle 兜底判定的最短任务时长

// ---- 速率统计参数（可调）----
const BURST_GAP_MS = 500; // delta 间隔超过此值视为非流式（工具/停顿/重试），排除并重启滑窗
const WINDOW_MS = 2000; // 滑窗长度（平稳优先）
const SAMPLE_MS = 100; // 采样限流
const MIN_WINDOW_MS = 800; // 出数所需的最小窗口跨度
const MIN_WINDOW_TOK = 4; // 出数所需的最小 token 增量
const EMA_ALPHA = 0.3; // 速率平滑系数
const CAL_ALPHA = 0.3; // charsPerToken 校准系数
const MIN_CPT = 1.2; // charsPerToken 合理区间，超出视为异常观测直接丢弃
const MAX_CPT = 6.0;
const INITIAL_CPT = 3.6; // 中英混合初值

/** 累加后的用量总量（原始 usage 里的 cost 是 { total } 对象，故单独取值） */
interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** 行2 统计的缓存单元：leaf 未移动 + 模型未变即可复用 */
interface SessionStats {
	totals: Totals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
}

/** 任务级计时状态 */
interface TaskTiming {
	start: number; // agent 任务开始时刻 (ms)，墙钟含工具调用
	elapsed: number; // 定格的总用时 (ms)，0 = 任务进行中
	ttft: number; // 最近一条 assistant 消息的首 token 延迟 (ms)
	requestStart: number; // 本轮 LLM 请求发出时刻 (ms)，TTFT 起算点
	outputTokens: number; // 本次 agent 任务累计真实输出 tokens
	tps: number; // 结束后定格的速率：outputTokens / streamMs
	streamMs: number; // 有效流式时长累计（tok/s 的分母，不含工具时间）
}

/** 流式采样状态 */
interface StreamSampling {
	chars: number; // 当前这条 assistant 消息累计输出字符数（估算用）
	rate: number; // 滑窗 EMA 后的显示速率（跨消息保留）
	samples: Array<[number, number]>; // [时刻, token 数]
	lastDeltaAt: number;
	lastSampleAt: number;
	charsPerToken: number; // 随 message_end 真实 usage 自校准
	msgTok0: number; // 本条消息开始时的 usage.output 基线
	usageBumps: number; // 本条消息内流式 usage 增长次数（≥2 判定 provider 实时回传）
	lastRealOutput: number;
}

const newTask = (): TaskTiming => ({
	start: 0,
	elapsed: 0,
	ttft: 0,
	requestStart: 0,
	outputTokens: 0,
	tps: 0,
	streamMs: 0,
});

const newStream = (): StreamSampling => ({
	chars: 0,
	rate: 0,
	samples: [],
	lastDeltaAt: 0,
	lastSampleAt: 0,
	charsPerToken: INITIAL_CPT,
	msgTok0: 0,
	usageBumps: 0,
	lastRealOutput: 0,
});

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

/**
 * 全量扫描会话条目得到行2 统计（复刻官方 footer 算法）。
 * getEntries() 每次调用都复制整个 session，getContextUsage() 还会重建 projection，
 * 而 footer 每帧 render（流式中最高 10Hz）→ 调用方按 leaf|model 缓存。
 */
function scanSession(ctx: ExtensionContext): SessionStats {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	const acc = (u: Usage) => {
		totals.input += u.input;
		totals.output += u.output;
		totals.cacheRead += u.cacheRead;
		totals.cacheWrite += u.cacheWrite;
		totals.cost += u.cost.total;
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
			latestCacheHitRate = prompt > 0 ? (entry.message.usage.cacheRead / prompt) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			acc(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			acc(entry.usage);
		}
	}

	return { totals, latestCacheHitRate, contextUsage: ctx.getContextUsage() };
}

/** 统计段（↑in ↓out R.. W.. CH..% $cost）+ 上下文占用 */
function statsPartsOf(stats: SessionStats, contextWindow: number, theme: Theme): string[] {
	const { totals, latestCacheHitRate, contextUsage } = stats;
	const parts: string[] = [];
	if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}
	if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);

	// 上下文占用（颜色随用量变化，同官方）；percent 为 null 表示压缩后尚未知
	const percent = contextUsage?.percent ?? null;
	const percentLabel = percent === null ? "?" : `${percent.toFixed(1)}%`;
	const window = formatTokens(contextUsage?.contextWindow ?? contextWindow);
	const display = `${percentLabel}/${window} (auto)`;
	parts.push(
		(percent ?? 0) > PCT_ERROR
			? theme.fg("error", display)
			: (percent ?? 0) > PCT_WARN
				? theme.fg("warning", display)
				: display,
	);
	return parts;
}

/** 左段 + 右对齐右段；右段放不下则截断，再放不下则只剩左段 */
function composeLine(left: string, right: string, width: number, theme: Theme): string {
	const leftWidth = visibleWidth(left);
	const avail = width - leftWidth - MIN_PADDING;
	const shownRight =
		visibleWidth(right) <= avail ? right : avail > 0 ? truncateToWidth(right, avail, "") : "";
	const pad = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(shownRight)));
	return theme.fg("dim", left) + theme.fg("dim", pad + shownRight);
}

/** 模型名 + 思考级别（+ provider 前缀，空间不足时退回不带前缀） */
function modelLabel(
	ctx: ExtensionContext,
	providerCount: number,
	leftWidth: number,
	width: number,
): string {
	const model = ctx.model;
	let label = model?.id || "no-model";
	if (model?.reasoning) {
		const level = ctx.thinkingLevel;
		label = level && level !== "off" ? `${label} • ${level}` : `${label} • thinking off`;
	}
	if (providerCount <= 1 || !model) return label;
	const withProvider = `(${model.provider}) ${label}`;
	return leftWidth + MIN_PADDING + visibleWidth(withProvider) > width ? label : withProvider;
}

export default function (pi: ExtensionAPI) {
	let tui: TUI | null = null;
	let ctxRef: ExtensionContext | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;
	let lastPaint = 0;
	let statsCache: { key: string; stats: SessionStats } | null = null;

	const task: TaskTiming = newTask();
	const stream: StreamSampling = newStream();

	function resetTask() {
		Object.assign(task, newTask());
		resetMessage();
		stream.rate = 0; // 速率不跨任务保留
	}

	function resetMessage() {
		// rate / charsPerToken 跨消息保留（速率连续、校准累积），其余字段归零
		// lastDeltaAt=0 → 首 delta 不计入 streamMs，TTFT 段天然排除
		const { rate, charsPerToken } = stream;
		Object.assign(stream, { ...newStream(), rate, charsPerToken });
	}

	function repaint() {
		const now = Date.now();
		if (now - lastPaint < REPAINT_MS) return;
		lastPaint = now;
		tui?.requestRender();
	}

	/** 绕过节流立即重绘（状态切换时用） */
	function forceRepaint() {
		lastPaint = 0;
		repaint();
	}

	// 当前累计输出 tokens：provider 流式中连续回传 usage → 真值；否则字符估算
	function currentTokens(): number {
		if (stream.usageBumps >= 2 && stream.lastRealOutput > stream.msgTok0) return stream.lastRealOutput;
		return stream.chars / stream.charsPerToken;
	}

	// 用滑窗首尾样本求瞬时速率并 EMA 平滑；窗口不足则保持原值（工具执行期间冻结）
	function updateRate() {
		if (stream.samples.length < 3) return;
		const [t0, k0] = stream.samples[0];
		const [t1, k1] = stream.samples[stream.samples.length - 1];
		const span = t1 - t0;
		const dTok = k1 - k0;
		if (span < MIN_WINDOW_MS || dTok < MIN_WINDOW_TOK) return;
		const inst = (dTok * 1000) / span;
		stream.rate = stream.rate > 0 ? stream.rate * (1 - EMA_ALPHA) + inst * EMA_ALPHA : inst;
	}

	// 定格任务计时：agent_end 正常路径与 isIdle() 兜底路径共用
	function finalizeTask(totalOutput?: number) {
		if (!task.start || task.elapsed) return;
		task.elapsed = Date.now() - task.start;
		const out = totalOutput && totalOutput > 0 ? totalOutput : task.outputTokens;
		// 与流式中同口径：分母只用有效流式时长，工具时间不掺入 → 收尾不跳变
		if (out > 0 && task.streamMs > MIN_WINDOW_MS) task.tps = out / (task.streamMs / 1000);
		forceRepaint();
	}

	// more-info 文本（无色，着色由 footer 统一处理）
	// 流式中：TTFT · ⚡滑窗速率 · 跳动秒数；结束后：⚡定格速率 · TTFT · 总用时
	function moreInfoText(): string {
		if (!task.start) return "";
		const parts: string[] = [];
		const shownRate = task.elapsed > 0 ? task.tps : stream.rate;
		if (task.ttft > 0) parts.push(`TTFT ${(task.ttft / 1000).toFixed(2)}s`);
		if (shownRate > 0) parts.push(`⚡${shownRate.toFixed(0)} tok/s`);
		parts.push(
			task.elapsed > 0
				? `总 ${(task.elapsed / 1000).toFixed(1)}s`
				: `${((Date.now() - task.start) / 1000).toFixed(1)}s`,
		);
		return parts.join(" · ");
	}

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		statsCache = null;
		resetTask();
		if (ctx.mode !== "tui") return; // footer 只存在于交互模式

		// 工具执行期间无流式事件，用定时器驱动秒数跳动 + 速率滑窗老化 + isIdle 兜底
		ticker ??= setInterval(() => {
			if (!task.start || task.elapsed) return;
			if (Date.now() - task.start > IDLE_GRACE_MS && ctxRef?.isIdle()) {
				finalizeTask(); // agent_end 漏触发（abort / 异常路径）时定格，避免秒数无限跳
				return;
			}
			if (stream.lastDeltaAt && Date.now() - stream.lastDeltaAt > BURST_GAP_MS) stream.samples = [];
			tui?.requestRender();
		}, TICK_MS);

		// 行2 统计缓存：leaf 未移动 + 模型未变即复用
		const sessionStats = (): SessionStats => {
			const key = `${ctx.sessionManager.getLeafId()}|${ctx.model?.id ?? ""}`;
			if (statsCache?.key !== key) statsCache = { key, stats: scanSession(ctx) };
			return statsCache.stats;
		};

		ctx.ui.setFooter((footerTui, theme, footerData) => {
			tui = footerTui;
			const unsub = footerData.onBranchChange(() => footerTui.requestRender());

			// ===== 行1：pwd (branch) • sessionName … more-info 右对齐（模型名正上方）=====
			const pwdLine = (width: number): string => {
				let pwd = formatCwdForFooter(
					ctx.sessionManager.getCwd(),
					process.env.HOME || process.env.USERPROFILE,
				);
				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) pwd = `${pwd} • ${sessionName}`;

				const mi = moreInfoText();
				const miWidth = visibleWidth(mi);
				const dimPwd = theme.fg("dim", pwd);
				// 空间不足（pwd 会被压到 24 列以下）时隐藏 more-info，保官方行1 完整
				if (mi === "" || width - miWidth - MIN_PADDING < MIN_PWD_WIDTH) {
					return truncateToWidth(dimPwd, width, theme.fg("dim", "..."));
				}
				const shownPwd = truncateToWidth(dimPwd, width - miWidth - MIN_PADDING, theme.fg("dim", "..."));
				const pad = " ".repeat(Math.max(MIN_PADDING, width - visibleWidth(shownPwd) - miWidth));
				return shownPwd + pad + theme.fg("accent", mi);
			};

			// ===== 行2：统计 + 右对齐模型名（more-info 已移到行1）=====
			const statsLine = (width: number): string => {
				const stats = sessionStats();
				const contextWindow = ctx.model?.contextWindow ?? 0;
				let left = statsPartsOf(stats, contextWindow, theme).join(" ");
				// 超宽时先截断统计段（同官方），再考虑右侧模型名
				if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");

				const right = modelLabel(
					ctx,
					footerData.getAvailableProviderCount(),
					visibleWidth(left),
					width,
				);
				return composeLine(left, right, width, theme);
			};

			// 复刻官方：ctx.ui.setStatus() 的内容以第三行呈现（接管 footer 后需手动补回）
			const statusLine = (width: number): string | null => {
				const statuses = footerData.getExtensionStatuses();
				if (statuses.size === 0) return null;
				const text = Array.from(statuses)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, v]) => v.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
					.join(" ");
				return truncateToWidth(text, width, theme.fg("dim", "..."));
			};

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const lines = [pwdLine(width), statsLine(width)];
					const status = statusLine(width);
					if (status) lines.push(status);
					return lines;
				},
			};
		});
	});

	// 模型 / 思考级别切换：render 直接读 ctx 实时 getter，这里只需重绘
	pi.on("model_select", () => tui?.requestRender());
	pi.on("thinking_level_select", () => tui?.requestRender());

	// 计时起点：整个 agent 任务开始（含中间所有工具调用）
	pi.on("agent_start", (_event, ctx) => {
		ctxRef = ctx;
		resetTask();
		task.start = Date.now();
		forceRepaint();
	});

	// TTFT 起算点：每轮 LLM 请求发出时刻（而非 agent 任务起点），逐轮独立。
	// before_provider_request 在 payload 构建完、紧贴发送前触发，比 turn_start 更精确，覆盖更新。
	pi.on("turn_start", () => {
		task.requestStart = Date.now();
	});
	pi.on("before_provider_request", () => {
		task.requestStart = Date.now();
	});

	// 每条 assistant 消息开始：只重置消息级统计（TTFT/采样窗口），不动任务计时
	pi.on("message_start", (event, ctx) => {
		ctxRef = ctx;
		const msg = event.message;
		if (msg.role !== "assistant") return;
		// abort/error 的收尾空消息会清掉本轮 TTFT，故直接跳过（正常流式此处为 "pending"）
		if (msg.stopReason === "aborted" || msg.stopReason === "error") return;
		task.ttft = 0;
		task.tps = 0;
		resetMessage();
		stream.msgTok0 = msg.usage.output;
		if (!task.requestStart) task.requestStart = Date.now(); // 事件缺失时兜底：近似以 message_start 起算
		forceRepaint();
	});

	pi.on("message_update", (event) => {
		const ev = event.assistantMessageEvent;
		if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;
		const now = Date.now();
		if (!task.start) task.start = now; // 惰性兜底
		if (!task.ttft) task.ttft = now - (task.requestStart || task.start);

		// 有效流式时长：只累计 ≤ BURST_GAP 的间隔；更大间隔是工具/停顿/重试 → 排除并重启滑窗
		if (stream.lastDeltaAt) {
			const gap = now - stream.lastDeltaAt;
			if (gap > BURST_GAP_MS) stream.samples = [];
			else task.streamMs += gap;
		}
		stream.lastDeltaAt = now;

		stream.chars += ev.delta.length;
		// partial 是 provider 原地 mutate 的同一 AssistantMessage 对象，流式中可读
		const real = ev.partial.usage.output;
		if (real > stream.msgTok0) {
			stream.usageBumps++;
			stream.lastRealOutput = real;
			if (stream.usageBumps === 2) stream.samples = []; // 估算→真值切换：丢弃旧样本，避免口径不连续污染速率
		}
		if (now - stream.lastSampleAt >= SAMPLE_MS) {
			stream.lastSampleAt = now;
			stream.samples.push([now, currentTokens()]);
			while (stream.samples.length > 2 && now - stream.samples[0][0] > WINDOW_MS) stream.samples.shift();
			updateRate();
		}
		repaint(); // 节流重绘 → 秒数与速率持续跳动
	});

	// 每条 assistant 消息结束：累计真实 output tokens，并用它反向校准 charsPerToken
	pi.on("message_end", (event) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		const out = msg.usage.output;
		task.outputTokens += out;
		if (out > 0 && stream.chars > 0) {
			const observed = stream.chars / out;
			if (observed >= MIN_CPT && observed <= MAX_CPT) {
				stream.charsPerToken = stream.charsPerToken * (1 - CAL_ALPHA) + observed * CAL_ALPHA;
			}
		}
		forceRepaint();
	});

	// agent 停止任务：定格墙钟，并用真实 output tokens / 有效流式时长定格速率
	pi.on("agent_end", (event) => {
		if (!task.start) return;
		// 官方 tps.ts 同款算法：agent_end 的 messages 里累加 output 作为权威总数
		let total = 0;
		for (const m of event.messages) {
			if (m.role === "assistant") total += m.usage.output;
		}
		finalizeTask(total);
	});

	pi.on("session_shutdown", () => {
		if (ticker) {
			clearInterval(ticker);
			ticker = null;
		}
	});
}
