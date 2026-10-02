# 当前 Cloudflare 处理逻辑

实现入口为 `worker/index.ts`，可视化见 [简单 HTML 调用链图](diagrams/project-call-chain.html)。旧的 19 图设计页仅为早期方案，包含每 10 分钟唤醒等未采用设计；当前以本文、部署说明和 `worker/` 代码为准。

外部调用链：GitHub 推送 `main` → Workers Builds 测试 → D1 迁移 → Worker 发布；每 3 小时 Cron → Worker → Codex Resets 公开 API / D1 / 126 SMTP。提交不确定时，下轮通过 126 IMAP 核对。无需 Pages 前端。

内部调用链：`scheduled()` 或 `POST /check` → `runMonitor()` → `Store.acquire()` / `state()` → `fetchStatus()` / `parseStatus()` → 恢复待处理事件 → `planNotifications()` → `Store.prepare()` / 邮件渲染 → `sendMail()` → `Store.complete()` → D1 触发器原子更新去重标记。

已知接受的邮件直接补写数据库。不确定事件先执行 `findReceived()`；找到邮件补写状态，未找到且已过缓冲期才允许重发，查询失败则暂缓。预测过期或被替代后不重发。恢复在重新发送前执行。

API 无效时不修改去重标记，也不发送邮件。数据库不可用或丢失租约时停止发送；手动执行与 Cron 通过同一个 D1 租约防止并发通知。SMTP 接受后的数据库写入重试不会再次调用发信接口。

规则和异常分支由 `worker-tests/` 的 Workers 运行时测试覆盖。SMTP 与 D1 无法形成一个分布式原子事务，IMAP 补偿降低重复风险，但不构成严格恰好一次投递保证。
