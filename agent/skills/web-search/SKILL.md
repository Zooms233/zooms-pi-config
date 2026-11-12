---
name: web-search
description: 联网检索：快速结论、事实查证（新闻/官网/文档）、社区观点与经验。查资料、查最新、核实事实时用；要证据链时用搜索，不用直答替代。
---

# 联网检索

- **快速结论** `zhihu-cli answer --query "<问题>"`：综合答案，不提供来源。
  `--model` 选 `zhida-fast-1p5`(默认)/`zhida-thinking-1p5`/`zhida-agent`；
  要纯文本加 `--stream --output text`；长任务加 `--timeout 200s`
- **事实检索** `zhihu-cli search global --query "<关键词>"`：新闻、官网、文档。
  时效内容加 `--search-db realtime`；限定站外用 `--filter 'host=="..."'`
- **社区观点** `zhihu-cli search zhihu --query "<关键词>"`：经验、案例、真实评价

## 要点

- 结果在 `Data.Items[]`：`Title` / `Url` / `ContentText`（含 `<em>` 需清理）。
  `ContentText` 是截取摘要而非全文，需要准确细节时打开 `Url`
- 复杂问题拆 2-3 条短关键词分别搜，不要用整句口语当 query
- 输出保留链接：`- 标题 — 作者 / 摘要 / 链接`；来源冲突时呈现差异
