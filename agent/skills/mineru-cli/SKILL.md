---
name: mineru-cli
description: 用官方 mineru-open-api CLI 把 PDF（含扫描件）解析为高质量 Markdown，保留表格、公式、图片。当用户提供 PDF 文件或 PDF 链接，要求读取、解析、总结、提取内容或转换格式时使用。
---

# MinerU PDF 解析

- 小文件取文字（免认证，≤10MB/20 页，仅 md）：`mineru-open-api flash-extract file.pdf -o ./.temp/`
- 高质量/大文件（需认证，≤200MB/200 页，含图片、表格、公式）：`mineru-open-api extract file.pdf -o ./.temp/ -f md,docx`
- 通用参数：`--ocr` 扫描件、`--pages 1-10`、`--language en`（默认 ch）
- 认证：`mineru-open-api auth`，`auth --verify` 验证
