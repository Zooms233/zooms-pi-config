---
name: github-cli
description: 用 gh CLI 把 GitHub 当外部知识库：找现成实现、搜 issue 排错、免 clone 读远端文件。
---

# GitHub 知识库检索

- 找仓库：`gh search repos "关键词" --language=go --sort=stars --json fullName,stargazersCount,description`
- 找代码用法：`gh search code "symbol" --language=go --json path,repository,url`
- 搜 issue：`gh search issues "报错关键词" --state=open --json number,title,repository`
- 读 issue：`gh issue view <n> -R OWNER/REPO --json title,body,comments`
- 读文件：`gh repo read-file pyproject.toml --repo OWNER/REPO [--ref TAG]`
- 列目录：`gh repo read-dir src --repo OWNER/REPO`
