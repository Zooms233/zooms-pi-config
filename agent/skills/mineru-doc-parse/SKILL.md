---
name: mineru-doc-parse
description: 用官方 mineru-open-api CLI 把 PDF、图片(png/jpg等)、Word、PPT、Excel、HTML 及网页解析为高质量 Markdown（保留表格、公式、图片，支持扫描件 OCR）。当用户提供这些格式的文档（本地文件或 URL）要求读取、解析、总结、提取内容或转换格式时使用。
---

# MinerU 文档解析

用 `mineru-open-api` 进行文档解析；命令语法用 `mineru-open-api --help` 查。

- `flash-extract <文件/URL>`：免认证，快速、只要文字；≤10MB/20 页、仅 Markdown、单文件
- `extract <文件/URL...>`：需认证，高质量（图片/表格/公式、多格式、批量）；≤200MB/600 页
- `crawl <URL...>`：需认证，网页正文 → Markdown/HTML

## 要点

- 必带 `-o <目录>`（省略则打 stdout），统一落当前工作目录下的 `.pi/workspace/mineru/`
- 结果以命令末行 `Done: <路径>` 为准；read 它（超 2000 行/50KB 用 offset 分段），图片直接 read 同目录文件
- 耗时随页数增长：bash timeout 设 ≥600；CLI 自带 `--timeout`。常用参数：`-f md,docx`、`-l ch|en|...`（默认 ch）、`--ocr`、`--pages`
- 认证：`mineru-open-api auth`（存 `~/.mineru/config.yaml`），`auth --verify` 验证
