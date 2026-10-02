# Codex Resets 126 邮件监控

[English](README.md) | 简体中文

[![测试](https://github.com/turmony/codex-resets/actions/workflows/test.yml/badge.svg)](https://github.com/turmony/codex-resets/actions/workflows/test.yml)

Cloudflare Worker 每隔 3 小时检查 Codex Resets 公开 API，通过同一个网易 126 邮箱发送和接收预测、预测更新、确认重置通知。GitHub 保存源码，Workers Builds 在推送 `main` 后测试并部署；通知状态保存在 D1，部署不清空历史。

## 部署和迁移

完整步骤见 [Cloudflare 部署说明](docs/cloudflare-migration.zh-CN.md)，调用链见 [HTML 流程图](docs/diagrams/project-call-chain.html)。现有部署的 Worker 名称为 `codex-resets-monitor`。

```bash
npm ci
npm run types
npm run typecheck
npm test
npm run build
```

需要 Node.js 24 和已登录的 Wrangler。首次自行部署时，创建 D1，修改 `wrangler.jsonc` 中的账户和数据库标识，再应用迁移、设置 Secrets 并部署，具体顺序见部署说明。

在 126 邮箱开启 **IMAP/SMTP** 服务，使用授权码。在 Worker 运行时配置三个 **Secret**：`MAIL_EMAIL`、`MAIL_SMTP_AUTH_CODE`、`ADMIN_TOKEN`。不要把邮箱或授权码放入 Git、普通变量或构建变量。

## 通知和恢复

- UTC Cron 为 `30 1-22/3 * * *`，对应北京时间 00:30、03:30、……、21:30。没有额外的每 10 分钟唤醒。
- 首次启用发一封启用邮件；导入已初始化的历史状态后不会再次发送。
- 有效预测指纹变化或新的确认重置才发信；过期预测不发送。
- 每封邮件先保存待发记录。SMTP 明确接受后，D1 在同一事务中保存提交结果与去重标记；写库失败只重试写库。
- 提交结果不确定时，下轮先通过 IMAP 查找对应事件。查到则补写状态；查不到且经过 30 分钟缓冲后才允许重试；IMAP 失败时暂缓重发。
- SMTP 和 D1 无法形成一个跨服务原子事务。该恢复策略降低重复风险，不承诺 SMTP 严格恰好投递一次。

## 管理

`GET /health` 仅提供服务健康摘要。`GET /status`、`POST /check` 和 `POST /verify-mail` 需要 `Authorization: Bearer <ADMIN_TOKEN>`；验证接口检查 SMTP/IMAP 连接和认证，不发送测试邮件。

本次迁移生成的管理令牌保存在忽略的 `.wrangler/admin-token` 文件中，也可通过 `ADMIN_TOKEN` 环境变量提供。命令不会打印令牌：

```bash
npm run admin -- status
npm run admin -- verify-mail
npm run admin -- check
```

需要代理时，设置 `HTTPS_PROXY` 后使用 `node --use-env-proxy scripts/admin.mjs status`。其他部署请用 `MONITOR_URL` 环境变量指定 Worker 地址。

## 开发和回滚

`npm run dev` 在本地模拟 Worker。私密配置放入忽略的 `.dev.vars`；本地 D1 使用 `npm run db:local`。Workers 测试使用独立数据库和模拟邮件连接，不访问生产资源。

原 Python 实现保留为行为参考和回滚路径，可用 `uv run --python 3.12 python -m unittest discover -s tests -v` 验证。旧监控 workflow 已改为手动执行，且需要勾选 `run_legacy`；回滚前先暂停 Worker，并把最新 D1 通知标记同步到 `state.json`，避免两套监控同时发信。

本项目只报告第三方全局公开状态，无法读取个人 Codex 额度或账户状态；预测不是 OpenAI 服务承诺。Cron 也不是精确到秒的实时通知机制。
