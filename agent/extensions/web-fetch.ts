/**
 * web-fetch.ts — 零成本、零依赖的网页正文抓取工具
 *
 * 用 Bun 内置的 HTMLRewriter（流式解析，源自 Cloudflare lol-html）剔除噪声节点、提取正文。
 *
 * 定位：执行层。搜索策略（拆词、补搜、结果整理）由 websearch skill 负责。
 *
 * 不做的两件事：
 *  1. 不执行 JavaScript —— JS 渲染站（知乎、部分 SPA）会抓不到，直接报错而非静默返回空。
 *  2. 不回落到付费接口 —— 抓不到就说抓不到，不花冤枉钱。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MS = 25_000;
const MAX_CHARS = 20_000;
const HARD_MIN = 50; // 低于此判定抓取失败（空壳页 / 纯 JS 渲染）
const SOFT_MIN = 400; // 低于此仍返回，但标记可能不完整

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 一律剔除的噪声标签与非正文区域 */
const JUNK =
  "script, style, noscript, iframe, svg, canvas, object, embed, " +
  "nav, footer, header, aside, form, button, input, select, textarea, " +
  '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [aria-hidden="true"]';

/** 正文根节点，按优先级探测（只做存在性判断，避免嵌套重复采集） */
const ROOTS = ["article", "main", '[role="main"]'] as const;

function pickRoot(html: string): string {
  for (const sel of ROOTS) {
    if (
      sel.startsWith("[")
        ? html.includes('role="main"') || html.includes("role='main'")
        : new RegExp(`<${sel}[\\s>]`, "i").test(html)
    ) {
      return sel;
    }
  }
  return "body";
}

function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return "";
  return decodeEntities(m[1].replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    laquo: "«",
    raquo: "»",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0
        ? String.fromCodePoint(code)
        : whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

/**
 * 清洗：剔除噪声、只采正文根的文本，规整空白。
 *
 * HTMLRewriter 的 handler 按文档顺序执行，因此在块级元素的 element 阶段
 * push 换行即可在文本片段之间插段落边界（text() 只拿到文本节点内容）。
 * 根节点内部用后代选择器 "root *"，避免嵌套的 root 标签重复采集。
 */
async function htmlToText(html: string, root: string): Promise<string> {
  const chunks: string[] = [];

  const rewriter = new HTMLRewriter()
    .on(JUNK, {
      element(el: any) {
        el.remove();
      },
    })
    .on(`${root}, ${root} *`, {
      text(t: any) {
        const s = t.text.replace(/\s+/g, " ");
        if (s.trim()) chunks.push(s);
      },
    })
    .on(
      "p, div, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, section, table, dt, dd",
      {
        element() {
          chunks.push("\n");
        },
      },
    )
    .on("br", {
      element() {
        chunks.push("\n");
      },
    });

  // Response 输入：transform 立刻返回，改写随 body 消费推进
  await rewriter.transform(new Response(html)).text();

  return decodeEntities(chunks.join(""))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function webFetch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "抓取网页并返回清洗后的正文（剔除脚本、导航、页脚等噪声）。本地执行、零成本、零依赖。" +
      "不执行 JavaScript：知乎、部分 SPA 等 JS 渲染站会返回错误，此时请改用对应 skill（如 websearch 的 zhihu 后端）或让用户直接提供内容。",
    promptGuidelines: [
      "拿到 URL 需要读正文时用 web_fetch，不要用 curl 直接拉 HTML（原始 HTML 体积大且充斥噪声）。",
      "纯文本、JSON、Markdown 等非 HTML 资源也会原样返回，无需额外处理。",
      "同一 URL 不要反复抓取；web_fetch 报错表示该站需要 JS 渲染，换来源比重试更有效。",
    ],
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "要抓取的 HTTP/HTTPS 地址，≤8192 字符，不能带用户名或密码",
        },
        max_chars: {
          type: "number",
          description: `返回正文的最大字符数，默认 ${MAX_CHARS}`,
        },
      },
      required: ["url"],
    } as any,

    async execute(
      _toolCallId: string,
      params: { url: string; max_chars?: number },
      signal?: AbortSignal,
    ) {
      const url = params.url?.trim();
      if (!url) throw new Error("url 不能为空");
      if (url.length > 8192) throw new Error("url 超过 8192 字符");
      if (!/^https?:\/\//i.test(url))
        throw new Error("url 必须是 http:// 或 https:// 开头");

      const limit = Math.min(
        200_000,
        Math.max(500, Math.round(params.max_chars ?? MAX_CHARS)),
      );
      const deadline = AbortSignal.timeout(TIMEOUT_MS);
      const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;

      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "User-Agent": UA,
            Accept:
              "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          redirect: "follow",
          signal: sig,
        });
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        throw new Error(
          `抓取失败（网络错误或 ${TIMEOUT_MS / 1000}s 超时）：${(err as Error).message}`,
        );
      }

      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}${res.status === 403 ? "（站点反爬，需要浏览器环境）" : res.status === 404 ? "（页面不存在）" : ""}：${url}`,
        );
      }

      const type = (res.headers.get("content-type") || "").toLowerCase();
      const isHtml =
        type.includes("html") || type.includes("xml") || type === "";

      if (!isHtml) {
        const raw = await res.text();
        return {
          content: [
            {
              type: "text" as const,
              text:
                raw.length > limit
                  ? `${raw.slice(0, limit)}\n…（已截断，原文 ${raw.length} 字符）`
                  : raw,
            },
          ],
          details: {
            url,
            contentType: type,
            mode: "raw" as const,
            chars: raw.length,
          },
        };
      }

      const html = await res.text();
      const root = pickRoot(html);
      const text = await htmlToText(html, root);
      const title = extractTitle(html);

      if (text.length < HARD_MIN) {
        throw new Error(
          `${url} 只提取到 ${text.length} 字符正文，判定为空壳页或纯 JS 渲染页（不执行 JavaScript）。` +
            `该站需要浏览器环境，请改用对应检索服务的原生接口（如 zhihu-cli），或让用户提供内容。`,
        );
      }

      const partial = text.length < SOFT_MIN;
      const body =
        text.length > limit
          ? `${text.slice(0, limit)}\n…（已截断，原文 ${text.length} 字符）`
          : text;
      const head = title ? `# ${title}\n\n` : "";
      const note = partial
        ? `\n\n---\n注：只提取到 ${text.length} 字符正文，可能不完整（页面主体可能依赖 JavaScript 渲染）。`
        : "";

      return {
        content: [{ type: "text" as const, text: head + body + note }],
        details: {
          url,
          title,
          mode: "html" as const,
          root,
          chars: text.length,
          truncated: text.length > limit,
          partial,
        },
      };
    },
  });
}
