# Codex Resets QQ 邮件监控

[English](README.md) | 简体中文

[![测试](https://github.com/turmony/codex-resets/actions/workflows/test.yml/badge.svg)](https://github.com/turmony/codex-resets/actions/workflows/test.yml)
[![监控](https://github.com/turmony/codex-resets/actions/workflows/monitor.yml/badge.svg)](https://github.com/turmony/codex-resets/actions/workflows/monitor.yml)

一个基于 GitHub Actions 的轻量监控工具，每小时检查 Codex Resets 公开状态 API，并通过 QQ 邮箱发送重置预测和公告。

## 主要功能

- 每小时整点运行，无需单独服务器。
- 发送启用、预测、预测更新和确认重置邮件。
- 使用同一个 QQ 邮箱发信和收信。
- 仅在 `state.json` 中保存公开通知标记，避免重复提醒。

## 快速部署

1. Fork 本仓库，或将代码推送到一个公开 GitHub 仓库。
2. 在 QQ 邮箱中启用 SMTP 服务并生成 SMTP 授权码。
3. 在 **Settings → Secrets and variables → Actions** 中添加两个仓库 Secrets：

   | Secret | 内容 |
   | --- | --- |
   | `QQ_EMAIL` | 你的 QQ 邮箱地址 |
   | `QQ_SMTP_AUTH_CODE` | QQ SMTP 授权码 |

4. 在 **Settings → Actions → General → Workflow permissions** 中选择 **Read and write permissions**。
5. 打开 **Actions → Monitor Codex Resets**，手动运行一次。首次成功运行会发送启用邮件并创建 `state.json`。

## 通知规则

工作流使用 `0 * * * *`，即 UTC 和北京时间的每个整点运行；GitHub Actions 可能延迟数分钟启动。

监控启用时，以及公开预测或确认重置发生变化时才会发信。如果数据源只提供预测窗口，没有准确时间或时区，本项目不会自行推测具体重置时刻。

## 安全与限制

- 不要提交或公开 QQ 邮箱、授权码、密码或令牌。
- Secrets 仅供生产工作流使用，拉取请求测试不会读取它们。
- `state.json` 只包含公开 API 派生的通知标记。
- 本项目展示第三方的全局状态信息，无法读取个人 Codex 额度、用量或账户状态；预测不构成 OpenAI 服务承诺。
- 公开仓库连续 60 天无活动时，GitHub 可能停用定时工作流。如监控停止，请重新启用并手动运行一次。

## 本地开发

需要 Python 3.12。使用以下命令运行测试：

```bash
uv run --python 3.12 python -m unittest discover -s tests -v
```
