---
name: websearch
description: 联网检索查阅。查资料、找社区观点或经验、了解最新动态、核实事实、找新闻/官网/文档、为回答补充背景时使用。两个后端：知乎站内（search zhihu）与全网（search global）。用户提到 知乎搜索、搜知乎、社区怎么说、联网搜索、网上查、搜一下、web search、查资料、查最新、最新消息、实时信息、事实核查、找官网、找文档 时使用。输出保留原始链接。
---

# 联网检索

`zhihu-cli` 两个搜索后端；两者都重要时分别调用再综合，不混成一个黑盒。

| 后端     | 命令                                                    | 适合                                     |
| -------- | ------------------------------------------------------- | ---------------------------------------- |
| 知乎站内 | `zhihu-cli search zhihu --query "<关键词>" --count 10`  | 社区观点、经验、案例（count ≤ 10）       |
| 全网     | `zhihu-cli search global --query "<关键词>" --count 10` | 新闻、官网、文档、外部证据（count ≤ 20） |

## 读原文

拿到 URL 需要读正文时，用 **`web_fetch` 工具** 。

- 不要用 `curl` 直拉 HTML：原始 HTML 体积大、充斥 script/导航，模型实际读不到正文。
- `web_fetch` 不执行 JavaScript：知乎、部分 SPA 会返回 403 或空壳页报错 —— 此时**换来源，不要重试**。知乎内容改用 `zhihu-cli search zhihu` / `question answers`。
- 纯文本 / JSON / Markdown 资源会原样返回，无需预处理。

## 检索要点

- 复杂问题拆成 2-3 条关键词组合分别搜；不要用整句口语当 query。
- 仅 `search global` 支持 `--search-db all|realtime|static`（时效内容用 `realtime`）与 `--filter 'host=="..."'`。
- 结果在 `Data.Items[]`：`Title`、`Url`、`ContentText`（含 `<em>` 需清理）。
- `search global` 会混入知乎链接，只要站外来源时按域名过滤。
- 摘要不等于原文（`ContentText` 约 1000 字），需要准确细节时用 `web_fetch` 读 `Url`。
- 输出按 `- 标题 — 作者 / 摘要 / 链接`；只留支撑结论的来源，来源冲突时呈现差异。
- 无结果换更短关键词或加 `--search-db realtime` 重查。
- 报 `AUTH_REQUIRED`：先 `zhihu-cli auth status --verify`。
