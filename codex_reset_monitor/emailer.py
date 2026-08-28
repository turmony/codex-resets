from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import smtplib
import ssl
import time
from typing import Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .domain import ResetInfo, StatusSnapshot, WatchInfo


class MailConfigurationError(Exception):
    """Raised when QQ SMTP settings are invalid."""


class MailDeliveryError(Exception):
    """Raised when a QQ SMTP delivery cannot be completed."""


@dataclass(frozen=True)
class MailContent:
    subject: str
    body: str


def _format_times(value: datetime) -> tuple[str, str]:
    utc_value = value.astimezone(timezone.utc)
    try:
        beijing_zone = ZoneInfo("Asia/Shanghai")
    except ZoneInfoNotFoundError:
        beijing_zone = timezone(timedelta(hours=8), "Asia/Shanghai")
    beijing_value = value.astimezone(beijing_zone)
    return (
        utc_value.strftime("%Y-%m-%d %H:%M:%S UTC"),
        beijing_value.strftime("%Y-%m-%d %H:%M:%S 北京时间"),
    )


def _time_lines(label: str, value: datetime) -> list[str]:
    utc_time, beijing_time = _format_times(value)
    return [f"{label}：{utc_time}", f"{label}：{beijing_time}"]


def _source_lines(text: str, url: str) -> list[str]:
    return [f"公告原文：{text}", f"来源链接：{url}"]


def render_activation(status: StatusSnapshot, checked_at: datetime) -> MailContent:
    lines = ["Codex Resets 监控已启用。"]
    if status.latest_reset is not None:
        lines.append(f"当前重置类型：{status.latest_reset.reset_type}")
        lines.extend(_time_lines("公告时间", status.latest_reset.announced_at))
        lines.extend(_source_lines(status.latest_reset.text, status.latest_reset.source.url))
    if status.active_watch is not None:
        probability = "未知" if status.active_watch.reset_chance_percent is None else f"{status.active_watch.reset_chance_percent}%"
        lines.extend([f"当前预测概率：{probability}", f"当前预测窗口：{status.active_watch.forecast_window}"])
    lines.extend(_time_lines("检测时间", checked_at))
    return MailContent("[Codex Resets] 监控已启用", "\n".join(lines))


def render_watch(watch: WatchInfo, checked_at: datetime, *, is_update: bool) -> MailContent:
    probability = "未知" if watch.reset_chance_percent is None else f"{watch.reset_chance_percent}%"
    prefix = "重置预警已更新" if is_update else "重置预警"
    subject_probability = "概率未知" if watch.reset_chance_percent is None else f"概率 {probability}"
    lines = [
        "以下内容为预测，不代表已确认重置。",
        f"预测概率：{probability}",
        f"预测级别：{watch.level}",
        f"预测窗口：{watch.forecast_window}",
    ]
    lines.extend(_time_lines("观察时间", watch.observed_at))
    lines.extend(_time_lines("失效时间", watch.expires_at))
    lines.extend(_source_lines(watch.text, watch.source.url))
    lines.extend(_time_lines("检测时间", checked_at))
    return MailContent(f"[Codex Resets] {prefix}：{subject_probability}", "\n".join(lines))


def render_reset(reset: ResetInfo, checked_at: datetime) -> MailContent:
    lines = [f"重置类型：{reset.reset_type}"]
    lines.extend(_time_lines("公告时间", reset.announced_at))
    lines.extend(_source_lines(reset.text, reset.source.url))
    lines.extend(_time_lines("检测时间", checked_at))
    return MailContent("[Codex Resets] Codex 已重置", "\n".join(lines))


class QQMailer:
    def __init__(
        self,
        email: str,
        auth_code: str,
        smtp_factory: Callable[..., smtplib.SMTP_SSL] = smtplib.SMTP_SSL,
        sleep: Callable[[float], None] = time.sleep,
    ):
        if (
            not isinstance(email, str)
            or not email.strip().lower().endswith("@qq.com")
            or not isinstance(auth_code, str)
            or not auth_code.strip()
        ):
            raise MailConfigurationError("QQ email configuration is invalid")
        self._email = email.strip()
        self._auth_code = auth_code
        self._smtp_factory = smtp_factory
        self._sleep = sleep

    def send(self, content: MailContent) -> None:
        message = EmailMessage()
        message["Subject"] = content.subject
        message["From"] = self._email
        message["To"] = self._email
        message.set_content(content.body, charset="utf-8")

        for attempt in range(2):
            try:
                with self._smtp_factory(
                    "smtp.qq.com", 465, timeout=20, context=ssl.create_default_context()
                ) as smtp:
                    smtp.login(self._email, self._auth_code)
                    smtp.send_message(message)
                return
            except (smtplib.SMTPException, OSError):
                if attempt == 0:
                    self._sleep(1)
        raise MailDeliveryError("QQ SMTP delivery failed") from None
