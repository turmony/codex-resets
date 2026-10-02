# Cloudflare 部署与迁移说明

实现日期：2026-10-02。项目使用 TypeScript Worker、Cron、D1 和 Workers Builds；现有 Python 保留为回滚参考。调用关系见 [简单 HTML 流程图](diagrams/project-call-chain.html)。管理首页由同一个 Worker 提供，无需单独的 Pages 项目。

## 当前部署

| 项目 | 值 |
| --- | --- |
| Worker | `codex-resets-monitor` |
| 地址 | `https://codex-resets-monitor.turmony.workers.dev` |
| D1 | `codex-resets-monitor` |
| 数据库 ID | `e3f0f69d-c582-4929-b02c-e83246faaa6a` |
| 生产仓库 / 分支 | `turmony/codex-resets` / `main` |
| Cron | `30 1-22/3 * * *`，UTC；北京时间每 3 小时半点 |
| 发信 / 核对 | `smtp.126.com:465` / `imap.126.com:993`，隐式 TLS |
| 状态 | D1 `monitor` 和 `notifications`，不再提交运行时状态到 GitHub |

2026-10-02 已完成切换并核验 GitHub 自动部署：提交 `fc6e2921d91ec98dee1ccfd71bd57887299b0cfe` 触发 Cloudflare 构建 `d6edfff9-767c-4c69-83be-e390e0dddf72`，触发来源为 `push_event`，构建和部署成功。Worker 版本为 `234edab4-a817-4791-9181-1b0f590a791c`。GitHub 回归测试通过（Python 73 项、Worker 45 项）。

自动部署后健康接口显示已启用且配置完整，SMTP/IMAP 连接验证均通过；北京时间 17:22 执行检查成功，发送 0 封、失败 0 项、无待处理通知，历史标记保持一致。邮件连接验证没有发送测试邮件，因此尚未通过生产环境实际通知验证最终收件。旧 GitHub 监控工作流已停用。

## 首次部署到自己的账户

1. 安装 Node.js 24，运行 `npm ci`、`npx wrangler login`。
2. 执行 `npx wrangler d1 create codex-resets-monitor`，将新账户 ID 和数据库 ID 填入 `wrangler.jsonc`。
3. 先将 `MONITOR_ENABLED` 设置为字符串 `false`。执行 `npx wrangler d1 migrations apply codex-resets-monitor --remote`。
4. 使用 `npx wrangler secret put MAIL_EMAIL`、`npx wrangler secret put MAIL_SMTP_AUTH_CODE`、`npx wrangler secret put ADMIN_TOKEN`，按交互提示输入。邮箱开启 IMAP/SMTP，授权码不是登录密码。
5. `npm run deploy`。如果旧监控仍在运行，先完成连接验证，再停用旧工作流并确认没有未完成运行。
6. 导入最终历史状态：`npm run import-state -- --remote state.json`。此脚本仅在未初始化、无通知记录且无有效租约时写入；不会覆盖已运行的 D1 状态。确认管理接口中的状态一致。
7. 将 `MONITOR_ENABLED` 改为 `true` 并部署，执行一次鉴权的 `POST /check`，检查状态和 Worker 日志。

初次创建 Worker 时，Wrangler 声明的必需 Secrets 会阻止不完整生产部署；可先用 `wrangler secret put` 建立 Worker 和 Secrets，再发布代码。本次迁移先发布了暂停监控的初始化版本，之后设置运行时 Secrets、导入状态并正式启用。

## GitHub 自动更新

Cloudflare 控制台选择 Worker → Settings → Builds，连接 GitHub 仓库，设置：

- 生产分支：`main`；项目目录：仓库根目录。
- 构建命令：`npm run types && npm run typecheck && npm test`。
- 部署命令：`npm run deploy`，先应用新增 D1 迁移，再发布代码。
- Node.js：24；构建变量可设置 `NODE_VERSION=24`。
- 构建令牌：目标账户上的 Workers Scripts Edit、D1 Edit，以及 Wrangler 所需的账户读取权限。
- 构建触发范围：Worker、SQL 迁移、脚本、Worker 测试、依赖和配置文件。文档和历史 `state.json` 更新无需发布 Worker。

邮箱配置只保存在 Worker 运行时 Secrets。自动部署保留 Secrets 和 D1 数据；不把邮箱授权码提供给构建或 PR 测试。第一次自动构建必须检查日志，确认仓库授权、测试、D1 权限和实际发布均成功，不能仅凭连接记录判断部署链已可用。

GitHub → Settings → Applications → Installed GitHub Apps → Cloudflare Workers & Pages 的仓库访问范围必须包含本项目；仅在 Cloudflare 建立连接或手动构建成功，仍不能证明 GitHub 推送事件已获授权。本次在补全仓库授权后完成了实际推送验证。

GitHub Actions `test.yml` 只做 Python 回归和 Worker 检查。`monitor.yml` 不再包含 schedule，保留手动回滚入口；线上监控不依赖 GitHub Actions runner。

## 运行与异常恢复

`worker/index.ts` 接收 Cron 或管理请求，`monitor.ts` 协调通知，`api.ts` / `domain.ts` 获取校验公开状态，`emailer.ts` 渲染中文邮件，`smtp.ts` / `imap.ts` 处理邮件协议，`store.ts` 调用 D1。

D1 租约有效期 5 分钟，单轮运行预算 3 分钟。获取租约失败跳过；写库和发送 DATA 前核对租约，旧执行不能覆盖新执行的状态。API 最多尝试 3 次，每次 15 秒，429 退避最多 30 秒。SMTP 和每次 IMAP 核对均有 25 秒总截止时间，响应长度有上限。

流程为：读取状态和待发记录 → 获取合法快照 → 先恢复不确定事件 → 判断当前需要的通知 → 保存待发任务 → SMTP 提交 → 保存结果。无变化不发信；过期预测只清理标记。初始化状态导入后不再发送启用邮件；预测指纹与原 Python 算法兼容。

通知状态为 `pending`、`sending`、`uncertain`、`accepted`、`sent`、`cancelled`。SMTP 最终返回 250 后表示服务器接受，随后退出会话失败仍视为已接受；写库只重试写库。`notifications` 转为 `sent` 时，SQLite 触发器在同一事务中更新公开去重标记，二者同时成功或回滚。

崩溃留下 `accepted` 时直接补写状态；留下 `sending` / `uncertain` 时，先按稳定事件 ID 搜索 IMAP 中所有可选文件夹，包括垃圾邮件。找到则补写；查询失败或无法完整枚举文件夹则暂缓。未找到且经过 30 分钟缓冲后，才允许重试仍有效的通知。过期或被新快照取代的预测取消。

SMTP 不能参与 D1 事务。即使 IMAP 未找到，迟到投递、用户删信和服务端索引延迟仍可能导致重复；该策略不承诺严格恰好一次。API 获取失败时本轮停止通知与恢复，等待下一次检查。

## 管理与验证

访问 Worker 根路径 `/` 打开管理首页，布局参考 `turmony/ikuuu-daily-checkin` 的 `src/page.js`。`worker/page.ts` 提供 HTML、CSS、JavaScript，分别通过 `/`、`/app.css`、`/app.js` 返回；静态页面不包含私密配置或监控标记。

页面打开时读取一次公开 `/health` 和 `/auth/status`。登录后读取 `/status`，显示运行摘要、下次计划检查、去重标记、待处理统计和最近 20 条通知；最近通知不返回邮件正文或收件人。页面不将密码存入 Cookie、localStorage 或 sessionStorage；退出后隐藏私密状态。

“立即检查”调用 `POST /check`，沿用正常通知规则；“验证邮件连接”调用 `POST /verify-mail`，不发送测试邮件。操作完成后刷新一次状态，不进行定时轮询。页面使用同源 CSS/JavaScript 和 CSP，管理修改接口拒绝来自其他 Origin 的请求。下次检查为 Cron 计划时间，不保证精确执行时刻。

### 密码登录与恢复

这是单管理员应用，不开放公众注册。`worker/auth.ts` 管理密码和会话，`0002_admin_auth.sql` 为 D1 添加 `admin_auth`、`admin_sessions` 和 `auth_attempts`，不修改监控历史。

1. 首次访问首页，使用原管理令牌作为恢复码，设置自己的登录密码。恢复码在本地 `.wrangler/admin-token`，对应 Worker Secret `ADMIN_TOKEN`；不要把它发到聊天或提交到 Git。
2. 密码须为 6–128 个字符，可包含中文和空格，不会自动去除密码首尾空格。确认两次输入一致后保存，再使用密码登录。
3. 登录后可展开“修改登录密码”，提供当前密码和新密码。
4. 忘记密码时，点击“忘记密码”，提供备用恢复码和新密码，无需原密码或邮件验证码。
5. 修改和重置成功后，所有设备必须重新登录；监控、去重标记和通知任务不受影响。

恢复码为长期备用凭据，请离线备份。若密码和恢复码都遗失，账户所有者可在 Cloudflare 控制台或通过 `wrangler secret put ADMIN_TOKEN` 设置新的随机恢复码，再在首页使用新恢复码重置密码；同时更新本地备份。`ADMIN_TOKEN` 也用作服务端密码 pepper，轮换后必须完成密码重置，原密码验证值不能继续使用。

密码验证使用 HMAC-SHA-256 服务端 pepper、16 字节随机盐和 100,000 次 PBKDF2-SHA-256，D1 只保存验证值。会话为 32 字节随机凭据，D1 只保存 SHA-256 摘要；Cookie 为 `__Host-monitor-session`，包含 `HttpOnly`、`Secure`、`SameSite=Strict`、`Path=/`，固定有效期 12 小时。退出删除对应会话，密码版本变化时 SQLite 触发器在同一事务中清除所有会话。登录写入会话时校验密码版本，防止并发重置后仍建立旧密码会话。

所有鉴权 POST 要求同源 Origin，JSON 请求最多 4 KiB、读取超时 10 秒；每 IP 15 分钟最多 10 次鉴权尝试，全局最多 60 次，设置、登录、修改和重置共用额度。登录密码和恢复码不写日志。未设置密码之前，保留原 Bearer 管理接口供首次切换验证；一旦设置密码，原令牌不再直接访问 `/status`、`/check` 或 `/verify-mail`。

| 接口 | 用途 |
| --- | --- |
| `GET /auth/status` | 公开返回密码是否已设置及本会话是否登录 |
| `POST /auth/setup` | 使用恢复码首次设置密码 |
| `POST /auth/login` | 验证密码，创建会话 Cookie |
| `POST /auth/logout` | 删除当前会话，清除 Cookie |
| `POST /auth/password` | 已登录且提供当前密码后修改密码 |
| `POST /auth/reset` | 使用备用恢复码重置密码 |

### 命令行管理

设置密码后，脚本从 `ADMIN_PASSWORD` 环境变量或忽略的 `.wrangler/admin-password` 文件读取密码，先登录，执行管理操作，再退出。密码文件可按需创建，内容为完整密码，脚本仅去掉文件末尾一个换行；它不会修改密码内部或其他空格。尚未设置密码时，兼容原 `ADMIN_TOKEN` 环境变量或 `.wrangler/admin-token` 文件。`MONITOR_URL` 指向其他部署。

```bash
npm run admin -- status
npm run admin -- verify-mail
npm run admin -- check
```

`verify-mail` 不发信，验证线上 TCP/TLS、SMTP 登录、IMAP 客户端 ID、登录、文件夹枚举和搜索。首次正常检查状态不变时，不人为生成邮件；实际邮件 DATA 提交和收件仍由正常通知路径执行。协议和故障分支在 Workers 运行时通过模拟连接验证。

需要代理时设置 `HTTPS_PROXY`，使用 `node --use-env-proxy scripts/admin.mjs status`。密码、恢复码和会话 Cookie 不会打印到终端。

公开健康接口只返回服务摘要，不提供邮箱或通知内容；管理接口使用登录会话鉴权。日志记录结果和脱敏错误，不记录 SMTP/IMAP 原始应答、认证字符串或 Secrets。

## 回滚

先暂停 Worker：将 `MONITOR_ENABLED` 改为 `false` 并部署，确认暂停后导出 D1 `monitor.state_json` 的最新公开标记，更新仓库 `state.json`。然后重新启用旧 workflow，并在手动运行时勾选 `run_legacy`。恢复长期 GitHub 定时监控时需重新添加 schedule；两套监控不能同时运行。

Worker 代码回滚不会回滚 D1 数据。保留数据库，不以删除数据库或清空通知历史作为回滚方式。

## 官方资料

- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [D1 Sessions 与事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Workers 运行时测试](https://developers.cloudflare.com/workers/testing/vitest-integration/)
