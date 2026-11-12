---
name: web-fetch
description: 抓取网页正文（剔除脚本/导航/页脚），本地零成本。需要读某个 URL 的正文时用。
---

# 网页正文抓取

- 基本用法：`webfetch <url>`，元信息走 stderr、正文走 stdout
- 控制长度：`--max-chars N`（默认 20000，范围 500–200000）
- 用 `webfetch` 替代 `curl`：只输出正文，不必自己从 HTML 里剥噪声
- 不执行 JavaScript：知乎、部分 SPA 抓不到会报错，换用 `web-search` 或让用户提供内容，不要对同一 URL 重试
- 非 HTML（纯文本/JSON/Markdown）原样返回
