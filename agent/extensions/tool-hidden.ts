/**
 * tool-hidden.ts — `ctrl+o` 三态轮转：collapsed → hidden → expanded → collapsed
 *
 *   collapsed / expanded：沿用内置渲染
 *   hidden              ：丢弃输出，只留一行斜体 `toolName...`
 *                         （块外壳的空行与背景由 pi 绘制，无法省掉）
 *
 * 渲染用 pi.registerToolRenderer()，只包 renderCall/renderResult，不改 tool 定义，
 * 故内置工具、MCP 工具、子 agent 工具一并生效。
 * 快捷键不用 registerShortcut（与内置 app.tree.filter.cycleForward 同键，会报冲突诊断），
 * 改用 setEditorComponent 替换编辑器，编辑器只在聚焦时收输入，/tree 下不冲突。
 *
 * 状态放 globalThis（Symbol.for）：/reload 会重执行模块，模块级变量会丢；
 * 进程内 /new、/resume、/reload 继承，重启回到 collapsed。
 */

import { CustomEditor, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey } from "@earendil-works/pi-tui";

type Mode = "collapsed" | "expanded" | "hidden";

// 进程级状态：跨 /new、/resume、/reload 继承，进程重启后重新初始化
const STATE_KEY = Symbol.for("pi-ext.tool-view.state");
const globalStore = globalThis as unknown as Record<symbol, { mode: Mode }>;
const state = (globalStore[STATE_KEY] ??= { mode: "collapsed" });

/**
 * toolCallId -> 弱引用该组件长期持有的 rendererState（context.state）。
 * 不能直接弱引用 context.invalidate：它是 getRenderContext() 每次新建的闭包，
 * 组件不持有它，GC 后 deref 即为 undefined。state 由 ToolExecutionComponent
 * 强持有（this.rendererState），组件移除后随之可回收，键也会在下次 cycle 清掉。
 */
const invalidators = new Map<string, WeakRef<{ invalidate?: () => void }>>();

/** 最近一次 session 的 UI 上下文，用于底部状态消息 */
let uiCtx: { notify(message: string, type?: "info" | "warning" | "error"): void } | undefined;

const NEXT: Record<Mode, Mode> = { collapsed: "hidden", hidden: "expanded", expanded: "collapsed" };

function cycle(): void {
	state.mode = NEXT[state.mode];
	for (const [toolCallId, ref] of invalidators) {
		const rendererState = ref.deref();
		if (!rendererState) {
			invalidators.delete(toolCallId);
			continue;
		}
		try {
			rendererState.invalidate?.();
		} catch {
			// 组件可能已被移除
		}
	}
	// notify -> showStatus，即内置 ctrl+o 原来那种底部 dim 提示
	uiCtx?.notify(`Tool blocks: ${state.mode}`, "info");
}

/**
 * 只替换渲染器：展开状态由全局 mode 决定，覆盖组件自身的 expanded。
 * 只包 base 已有的渲染器，没有的留给 pi 自己的 fallback（会格式化参数）。
 * 必须 spread base，否则丢掉 name/label/execute/renderShell 等定义字段。
 */
function decorate(base: ToolDefinition, fallbackName: string): ToolDefinition {
	const name = base.label || fallbackName;
	const { renderCall, renderResult } = base;
	const out: ToolDefinition = { ...base };

	/** 记住该组件的重绘句柄（见 invalidators 注释） */
	const track = (context: any) => {
		context.state.invalidate = context.invalidate;
		invalidators.set(context.toolCallId, new WeakRef(context.state));
	};

	if (renderCall) {
		out.renderCall = (args, theme, context) => {
			track(context);
			if (state.mode === "hidden") {
				return new Text(theme.italic(theme.fg("muted", `${name}...`)), 0, 0);
			}
			return renderCall(args, theme, { ...context, expanded: state.mode === "expanded" });
		};
	}

	if (renderResult) {
		out.renderResult = (result, options, theme, context) => {
			track(context);
			if (state.mode === "hidden") return new Text("", 0, 0);
			const expanded = state.mode === "expanded";
			return renderResult(result, { ...options, expanded }, theme, { ...context, expanded });
		};
	}

	return out;
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
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		return base && decorate(base, toolName);
	});

	pi.registerCommand("tool-view", {
		description: "Cycle tool block view: collapsed / expanded / hidden",
		handler: () => cycle(),
	});

	pi.on("session_start", (_event, ctx) => {
		// 只清理与旧组件绑定的重绘句柄；显示状态保留（/new、/resume、/reload 继承）
		invalidators.clear();
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
	});
}
