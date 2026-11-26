---
name: pubmed
description: 检索 PubMed 文献、取题录与摘要、DOI/PMID/PMCID 互查。查文献、找某篇论文信息时用。
---

# PubMed 检索

- 检索（默认 20 条、按相关度）：`pubmed search "crispr[tiab] AND 2025:2026[dp]" -n 10`
  - 最新优先 `--sort pub_date`；限年份 `--from 2020 --to 2024`
- 取摘要：`pubmed abstract 38632405`（多个 PMID 空格分隔；输出纯文本，作者带编号如 `Kalita E(1)`）
- ID 互查（DOI / PMID / PMCxxxxxxx 任给一个）：`pubmed id 10.1038/s41586-024-07337-9`
- 字段：`[tiab]` 标题摘要、`[au]` 作者、`[dp]` 出版日、`[mh]` MeSH、`[pt]` 类型；`AND/OR/NOT`，短语加引号
- 每条输出：`标题 — 期刊 年份 / PMID / DOI / PMC`；stderr 的 `count=` 是总命中数
- 全文：`pubmed fulltext 38003266`（或 PMC 号）→ 存 `.temp/PMCxxxxxxx.txt` 并打印路径，`-o DIR` 换目录；只有带 `PMC:` 的开放获取文献才有，无则说明需用户提供 PDF
- 命中 0 条时放宽检索式（去字段限定、拆 AND），不要重复同一查询
