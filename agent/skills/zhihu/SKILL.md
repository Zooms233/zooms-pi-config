---
name: zhihu
description: 知乎开放平台 CLI（zhihu-cli）的操作能力：热榜、知乎直答、问题推荐与回答摘要、本人创作全文/评论/数据、关注与收藏、知识库检索与上传、API 额度、知乎黑客松。用户提到 热榜、热点、知乎直答、问题推荐、选题、回答摘要、我的知乎内容、我的关注、我的收藏、知识库、RAG、API 额度、剩余额度、用量、知乎黑客松、知乎登录、开放平台、MCP、Access Secret 时使用。本人数据与知识库只读所需范围。
---

# 知乎操作

全部通过 `zhihu-cli` 完成。不确定参数先 `zhihu-cli <command> --help`，能力清单 `zhihu-cli capabilities`。

- 热榜：`zhihu-cli hot --limit 20`
- 直答：`zhihu-cli answer --query "<问题>"`（长任务加 `--timeout 200s`）
- 选题：`zhihu-cli question recommend [--query "<主题>"] --count 5`
- 回答摘要：`zhihu-cli question answers --question-url "<url>" --limit 20`
- 我的：`zhihu-cli me contents|followees|favorites|content|comments|stats ...`
- 知识库：`zhihu-cli knowledge bases|items|search|upload`（`upload` 固定加 `--progress`）
- 额度：`zhihu-cli quota [--api-id <id>]`

## 首次检查

- 每 Session 一次：`zhihu-cli auth status --verify`（`zhihu-cli status` 必须带 `--skill-version`/`--min-cli-version`，直接跑会报错）
- 未配置：用户到 <https://developer.zhihu.com/profile> 生成 Access Secret → `zhihu-cli auth set --secret-stdin`，不在回复中复述

## 边界与错误

- 摘要不等于原文；本人命令不传 OAuth/用户 ID；不遍历全部关注收藏；不批量上传。
- `AUTH_REQUIRED`/凭证无效：按 `action_url` 引导，不回显原值。
- 配额限流停止重试；直答 POST 不额外重试；知识库上传超时先用 `knowledge items` 核对。
