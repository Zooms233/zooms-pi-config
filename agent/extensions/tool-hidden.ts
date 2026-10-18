/**
 * tool-hidden.ts — 给 pi 的 tool 块增加第三种显示状态，`ctrl+o` 三态轮转：
 *
 *   collapsed → hidden → expanded → collapsed → ...
 * 默认 collapsed，每次按下都按上述顺序流转。
 *
 *   collapsed / expanded：完全沿用内置渲染（截断 / 完整输出）
 *   hidden              ：只显示一行斜体 `toolName...`
 *
 * 状态保存位置：
 *   pi 的扩展加载器是 moduleCache:false（loader.ts），/reload 会重新执行模块，
 *   模块级变量会重置。因此显示状态放在进程级 globalThis（Symbol.for 命名）：
 *     - /new、/resume、/reload：同一进程，继承上一次状态
 *     - 退出后重启 pi：进程重建，回到默认 collapsed
 *
 * 接管方式（替换编辑器组件，不用 registerShortcut）：
 *   注册 ctrl+o 快捷键会与内置 app.tree.filter.cycleForward 同键，触发 pi 的
 *   快捷键冲突诊断（[Extension issues]，无设置可隐藏）。改为用
 *   ctx.ui.setEditorComponent() 把默认编辑器换成 CustomEditor 子类，在
 *   handleInput 里先拦 ctrl+o；编辑器只在聚焦时收到输入，/tree 打开时焦点在
 *   TreeSelectorComponent，故不冲突、也无诊断。
 *
 * 鼠标点击工具块仍可用：组件内部 expanded 变化会被检测到并同步为 collapsed/expanded。
 */

import {
	CustomEditor,
	SettingsManager,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey } from "@earendil-works/pi-tui";

type Mode = "collapsed" | "expanded" | "hidden";

interface ViewState {
	mode: Mode;
}

// 进程级状态：跨 /new、/resume、/reload 继承，进程重启后重新初始化
const STATE_KEY = Symbol.for("pi-ext.tool-view.state");
const globalStore = globalThis as unknown as Record<symbol, ViewState>;
const state: ViewState = (globalStore[STATE_KEY] ??= { mode: "collapsed" });

/** toolCallId -> 该 tool 组件的局部重绘函数 */
const invalidators = new Map<string, () => void>();
/** toolCallId -> 上一次观察到的“组件内部 expanded”，用于识别鼠标点击 */
const seenExpanded = new Map<string, boolean>();
/** 最近一次 session 的 UI 上下文，用于底部状态消息 */
let uiCtx: { notify(message: string, type?: "info" | "warning" | "error"): void } | undefined;

function refreshAll(): void {
	for (const invalidate of invalidators.values()) {
		try {
			invalidate();
		} catch {
			// 组件可能已被移除
		}
	}
}

/** 渲染过程中不要同步重绘其它组件，推迟到当前渲染结束后 */
function deferRefreshAll(): void {
	queueMicrotask(refreshAll);
}

/** 组件内部 expanded 被外部改变（鼠标点击）时，把全局 mode 同步过去 */
function syncInternalExpanded(toolCallId: string, internalExpanded: boolean): void {
	const prev = seenExpanded.get(toolCallId);
	seenExpanded.set(toolCallId, internalExpanded);
	if (prev === undefined || prev === internalExpanded) return;
	state.mode = internalExpanded ? "expanded" : "collapsed";
	deferRefreshAll();
}

function wrapDefinition(definition: ToolDefinition): ToolDefinition {
	const baseCall = definition.renderCall;
	const baseResult = definition.renderResult;
	const name = definition.label || definition.name;

	return {
		...definition,

		renderCall(args: any, theme: any, context: any) {
			invalidators.set(context.toolCallId, context.invalidate);
			syncInternalExpanded(context.toolCallId, context.expanded);

			if (state.mode === "hidden") {
				return new Text(theme.italic(theme.fg("muted", `${name}...`)), 0, 0);
			}
			const expanded = state.mode === "expanded";
			return baseCall
				? baseCall(args, theme, { ...context, expanded })
				: new Text(theme.fg("toolTitle", theme.bold(definition.name)), 0, 0);
		},

		renderResult(result: any, options: any, theme: any, context: any) {
			invalidators.set(context.toolCallId, context.invalidate);
			syncInternalExpanded(context.toolCallId, context.expanded);

			if (state.mode === "hidden") {
				// 只保留 renderCall 那一行 `name...`
				return new Text("", 0, 0);
			}
			const expanded = state.mode === "expanded";
			return baseResult
				? baseResult(result, { ...options, expanded }, theme, { ...context, expanded })
				: new Text("", 0, 0);
		},
	};
}

function buildDefinitions(cwd: string): ToolDefinition[] {
	let shellPath: string | undefined;
	let commandPrefix: string | undefined;
	let autoResizeImages = true;
	try {
		const settings = SettingsManager.create(cwd);
		shellPath = settings.getShellPath();
		commandPrefix = settings.getShellCommandPrefix();
		autoResizeImages = settings.getImageAutoResize();
	} catch {
		// 读设置失败就退回内置默认值
	}

	return [
		createReadToolDefinition(cwd, { autoResizeImages }),
		createBashToolDefinition(cwd, { shellPath, commandPrefix }),
		createPowerShellToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	] as unknown as ToolDefinition[];
}

function nextMode(): Mode {
	if (state.mode === "expanded") return "collapsed";
	if (state.mode === "collapsed") return "hidden";
	return "expanded";
}

function cycle(): void {
	state.mode = nextMode();
	refreshAll();
	// notify -> showStatus，即内置 ctrl+o 原来那种底部 dim 提示
	uiCtx?.notify(`Tool blocks: ${state.mode}`, "info");
}

/** 只在编辑器聚焦时收到输入，因此 /tree 等场景不会触发本逻辑 */
class ToolViewEditor extends CustomEditor {
	override handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("o"))) {
			cycle();
			return;
		}
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	for (const definition of buildDefinitions(process.cwd())) {
		pi.registerTool(wrapDefinition(definition));
	}

	pi.registerCommand("tool-view", {
		description: "Cycle tool block view: collapsed / expanded / hidden",
		handler: (_args, _ctx) => cycle(),
	});

	pi.on("session_start", (_event, ctx) => {
		// 只清理与旧组件绑定的重绘句柄；显示状态保留（/new、/resume、/reload 继承）
		invalidators.clear();
		seenExpanded.clear();
		uiCtx = ctx.ui;

		if (ctx.mode !== "tui") return;
		// 替换默认编辑器；pi 会把默认编辑器的 actionHandlers / onExtensionShortcut
		// 复制过来，故其余按键行为不变。
		// embedWorkingStatus 必须显式传，否则加载动画不嵌入编辑器边框。
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new ToolViewEditor(tui, theme, keybindings, { embedWorkingStatus: true }),
		);
	});

	pi.on("session_shutdown", () => {
		invalidators.clear();
		seenExpanded.clear();
	});
}
