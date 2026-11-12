/**
 * yankcode.ts — 复制 assistant 回答里的 Markdown 代码块原文
 *
 * 读 session 里的原始 Markdown，避开 fullscreen 拖选把软换行变硬换行的问题。
 *   /yc [序号]  /yankcode
 * 只认 fenced block（```/~~~，≤3 空格缩进，闭合需同字符且不短于开启）；
 * 未闭合块、4 空格缩进块不支持。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

interface CodeBlock {
	index: number; // 1-based，用于 /yc N
	lang: string; // info string 首个 token，空串=未标注
	code: string;
	lineCount: number;
	preview: string; // 首个非空行，选择列表用
}

interface OpenFence {
	char: string;
	len: number;
	indent: number;
	lang: string;
	content: string[];
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function removeIndent(line: string, maxIndent: number): string {
	let count = 0;
	while (count < maxIndent && line[count] === " ") count++;
	return line.slice(count);
}

function buildBlock(index: number, open: OpenFence): CodeBlock {
	const previewLine = open.content.find((line) => line.trim() !== "") ?? "";
	return {
		index,
		lang: open.lang,
		code: open.content.join("\n"),
		lineCount: open.content.length,
		preview: truncateToWidth(previewLine.trim(), 40, "…"),
	};
}

function extractCodeBlocks(markdown: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	let open: OpenFence | undefined;

	for (const line of markdown.split("\n")) {
		const match = FENCE_RE.exec(line);

		if (open) {
			const closes =
				match !== null &&
				match[2]![0] === open.char &&
				match[2]!.length >= open.len &&
				match[3]!.trim() === "";
			if (closes) {
				blocks.push(buildBlock(blocks.length + 1, open));
				open = undefined;
				continue;
			}
			open.content.push(removeIndent(line, open.indent));
			continue;
		}

		if (!match) continue;
		const fence = match[2]!;
		const info = match[3]!.trim();
		// CommonMark：反引号 fence 的 info string 不能含反引号
		if (fence[0] === "`" && info.includes("`")) continue;
		open = {
			char: fence[0]!,
			len: fence.length,
			indent: match[1]!.length,
			lang: info.split(/\s+/)[0] ?? "",
			content: [],
		};
	}

	return blocks;
}

function getLastAssistantBlocks(ctx: ExtensionCommandContext): CodeBlock[] | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant") continue;

		let text = "";
		for (const part of message.content) {
			if (part.type === "text") text += part.text;
		}
		const blocks = extractCodeBlocks(text);
		if (blocks.length > 0) return blocks;
	}
	return undefined;
}

function formatLabel(block: CodeBlock): string {
	const lang = block.lang || "text";
	const preview = block.preview ? ` · ${block.preview}` : "";
	return `${block.index}. ${lang} · ${block.lineCount} 行${preview}`;
}

export default function yankCodeExtension(pi: ExtensionAPI) {
	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.isIdle()) {
			ctx.ui.notify("等回答完成后再复制", "warning");
			return;
		}

		const blocks = getLastAssistantBlocks(ctx);
		if (blocks === undefined) {
			ctx.ui.notify("没有找到代码块", "warning");
			return;
		}

		const arg = args.trim();
		let target: CodeBlock | undefined;

		if (/^\d+$/.test(arg)) {
			target = blocks.find((block) => block.index === Number(arg));
			if (!target) {
				ctx.ui.notify(`只有 ${blocks.length} 个代码块`, "warning");
				return;
			}
		} else if (blocks.length === 1) {
			target = blocks[0];
		} else {
			const labels = blocks.map(formatLabel);
			const choice = await ctx.ui.select("选择要复制的代码块", labels);
			if (choice === undefined) return;
			const index = labels.indexOf(choice);
			if (index >= 0) target = blocks[index];
		}

		if (!target) return;

		try {
			await copyToClipboard(target.code);
			ctx.ui.notify(`已复制：${target.lang || "text"} · ${target.lineCount} 行`, "info");
		} catch (error) {
			ctx.ui.notify(`复制失败：${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.registerCommand("yc", {
		description: "复制上一条回答里的代码块（/yc [序号]）",
		handler,
	});

	pi.registerCommand("yankcode", {
		description: "复制上一条回答里的代码块（/yankcode [序号]）",
		handler,
	});
}
