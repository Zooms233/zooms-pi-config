---
name: github-knowledge
description: Query GitHub as an external knowledge base via gh CLI. Use when the user asks to find code examples, look up how a library or API is used in real projects, find repos, read files from a repo without cloning, or search issues for error messages and known pitfalls.
---

# GitHub 知识库检索

用 `gh` CLI 查询 GitHub。命令语法用 `gh --help` 查。

## 核心原则

- **先检索，再按需取用**：单点查询用 `gh search code|repos|issues` 定位 → `gh repo read-file` 只取命中片段。若需跨多文件深度检索，clone 到临时目录后用 `rg` 检索
- 排查报错时先搜 issue（经验法则：命中率高，非保证）。
- 输出用 `--json` + `--jq` 过滤，别拉回无关字段。
- `read-dir` / `read-file` 是 preview 功能；不在 git 仓库内时必须带 `-R OWNER/REPO`。
- 403 时查 `gh api rate_limit`。
