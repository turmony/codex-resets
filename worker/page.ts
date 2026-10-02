// Layout follows turmony/ikuuu-daily-checkin's src/page.js.
// Static assets contain no runtime credentials or private monitoring data.
export const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Codex Resets 邮件监控</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/app.css">
</head>
<body><main>
  <header>
    <h1>Codex Resets 邮件监控</h1>
    <p>北京时间每 3 小时半点检查一次，预测变化或确认重置时通过原 126 邮箱发送通知。</p>
  </header>
  <section aria-labelledby="serviceTitle">
    <h2 id="serviceTitle">服务状态</h2>
    <p id="service" role="status">正在读取服务状态…</p>
    <p class="hint">检查时间：00:30、03:30、06:30、09:30、12:30、15:30、18:30、21:30。</p>
  </section>
  <section aria-labelledby="accessTitle">
    <h2 id="accessTitle">管理登录</h2>
    <p id="accessHint">正在读取登录设置…</p>
    <form id="loginForm" hidden>
      <label for="password">登录密码</label>
      <input id="password" type="password" autocomplete="current-password" maxlength="128" placeholder="输入你设置的密码" required>
      <button id="login" type="submit">登录</button>
    </form>
    <form id="setupForm" hidden autocomplete="off">
      <p>首次使用，请验证恢复码并设置自己的登录密码。</p>
      <label for="setupCode">备用恢复码</label>
      <input id="setupCode" type="password" autocomplete="off" maxlength="512" placeholder="输入原管理令牌作为恢复码" required>
      <label for="setupPassword">登录密码</label>
      <input id="setupPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" placeholder="6–128 个字符，可以使用中文或空格" required>
      <label for="setupConfirm">确认密码</label>
      <input id="setupConfirm" type="password" autocomplete="new-password" minlength="6" maxlength="128" required>
      <button id="setup" type="submit">设置密码</button>
      <p class="hint">恢复码请离线保存，忘记密码时需要它；日常登录只需密码。</p>
    </form>
    <button id="forgot" type="button" class="secondary" hidden>忘记密码</button>
    <div id="signedIn" hidden>
      <p>已登录。登录会话最长有效 12 小时。</p>
      <button id="load" type="button">刷新状态</button>
      <button id="logout" type="button" class="secondary">退出登录</button>
    </div>
  </section>
  <section id="resetSection" aria-labelledby="resetTitle" hidden>
    <h2 id="resetTitle">重置密码</h2>
    <p>使用备用恢复码验证身份，重新设置登录密码。</p>
    <form id="resetForm" autocomplete="off">
      <label for="resetCode">备用恢复码</label>
      <input id="resetCode" type="password" autocomplete="off" maxlength="512" required>
      <label for="resetPassword">新密码</label>
      <input id="resetPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" placeholder="6–128 个字符，可以使用中文或空格" required>
      <label for="resetConfirm">确认新密码</label>
      <input id="resetConfirm" type="password" autocomplete="new-password" minlength="6" maxlength="128" required>
      <button id="reset" type="submit">重置密码</button>
      <button id="back" type="button" class="secondary">返回登录</button>
    </form>
    <p class="hint">重置成功后，所有已登录设备会立即退出。重置密码不会修改通知记录，也不会暂停监控。</p>
  </section>
  <p id="message" role="status" aria-live="polite"></p>
  <section id="overview" aria-labelledby="overviewTitle" hidden>
    <h2 id="overviewTitle">运行状态</h2>
    <dl id="facts"></dl>
    <div class="actions">
      <button id="run" type="button">立即检查</button>
      <button id="verify" type="button" class="secondary">验证邮件连接</button>
    </div>
    <p class="hint">立即检查沿用正常通知规则，有新事件时会发信。连接验证仅检查 SMTP/IMAP，不发送测试邮件。</p>
  </section>
  <section id="pendingSection" aria-labelledby="pendingTitle" hidden>
    <h2 id="pendingTitle">待处理通知</h2>
    <div id="pending"></div>
  </section>
  <section id="historySection" aria-labelledby="historyTitle" hidden>
    <h2 id="historyTitle">最近通知</h2>
    <div id="history"></div>
    <p class="hint">最多显示最近 20 条通知任务；没有变化的例行检查不会生成通知记录。</p>
  </section>
  <section id="passwordSection" hidden>
    <details><summary>修改登录密码</summary>
      <form id="changeForm">
        <label for="currentPassword">当前密码</label>
        <input id="currentPassword" type="password" autocomplete="current-password" maxlength="128" required>
        <label for="newPassword">新密码</label>
        <input id="newPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" placeholder="6–128 个字符，可以使用中文或空格" required>
        <label for="newConfirm">确认新密码</label>
        <input id="newConfirm" type="password" autocomplete="new-password" minlength="6" maxlength="128" required>
        <button id="change" type="submit">修改密码</button>
      </form>
      <p class="hint">修改后所有会话会立即退出，请使用新密码重新登录。</p>
    </details>
  </section>
  <footer>时间均为北京时间。邮件“已提交”表示发送结果已记录，不代表最终送达。页面只在打开或操作时读取状态。</footer>
</main><script src="/app.js" defer></script></body>
</html>`;

export const css = `
:root{font-family:system-ui,sans-serif;color:#182638;background:#f3f6fb;color-scheme:light}
*{box-sizing:border-box}body{margin:0}main{max-width:800px;padding:32px 20px;margin:auto}
header{margin-bottom:24px}h1{font-size:30px;line-height:1.3}h2{font-size:20px;margin:0 0 16px}
p,footer{line-height:1.65;color:#536277}section{background:white;border:1px solid #dce4ef;border-radius:12px;padding:22px;margin:18px 0}
label{display:block;font-weight:600;margin:12px 0 8px}input{width:100%;min-width:0;padding:12px;border:1px solid #b9c6d9;border-radius:6px;font:inherit}
button{padding:11px 16px;background:#265bcb;color:white;border:1px solid #265bcb;border-radius:6px;cursor:pointer;font:inherit;margin:12px 8px 0 0}
button.secondary{background:#fff;color:#265bcb}button:disabled{opacity:.5;cursor:wait}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #94b8ff;outline-offset:3px}summary{font-weight:600;cursor:pointer}
.hint,footer{font-size:13px}dl{display:grid;grid-template-columns:145px minmax(0,1fr);gap:14px;margin:0}
dt{color:#536277}dd{margin:0;overflow-wrap:anywhere}.record{padding:12px 0;border-bottom:1px solid #e7edf5}
.record:last-child{border-bottom:0}.record p{margin:4px 0}.record strong{font-size:15px}.record .hint{margin-bottom:0}
.error{color:#aa2634}#message,#service,.record{overflow-wrap:anywhere}[hidden]{display:none!important}
@media(max-width:480px){main{padding:16px}section{padding:16px}h1{font-size:26px}dl{grid-template-columns:110px minmax(0,1fr)}}
`;

export const js = `
'use strict';
const get = id => document.getElementById(id);
const kinds = { activation: '启用通知', forecast: '预测通知', reset: '确认重置' };
const statuses = { pending: '等待发送', sending: '正在提交', uncertain: '等待核对发送结果', accepted: '已接受，等待记录', sent: '已提交', cancelled: '已取消' };
const results = { ok: '检查成功', partial: '部分通知待处理', failed: '检查失败', busy: '已有检查正在执行', disabled: '监控已暂停', unconfigured: '邮件配置不完整' };
const errors = { 'smtp outcome uncertain': '发送结果不确定，等待邮件核对', 'smtp submission failed': '邮件提交失败，等待重试', 'event expired or superseded': '事件已过期或已被更新', 'event expired': '事件已过期', 'event superseded': '事件已被更新' };
let authenticated = false, passwordSet = false, resetMode = false, accessVersion = 0;
function time(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
}
function message(text, error = false) {
  get('message').textContent = text;
  get('message').className = error ? 'error' : '';
}
function hidePrivate() {
  for (const id of ['overview', 'pendingSection', 'historySection', 'passwordSection']) get(id).hidden = true;
  for (const id of ['facts', 'pending', 'history']) get(id).replaceChildren();
}
function renderHealth(health) {
  get('service').textContent = (health.enabled ? '定时监控已启用' : '定时监控已暂停') + ' · ' + (health.configured ? '邮件配置完整' : '邮件配置不完整');
  get('service').className = health.configured ? '' : 'error';
}
function render(data) {
  renderHealth(data.health);
  const monitor = data.monitor || {};
  const state = monitor.state_json ? JSON.parse(monitor.state_json) : {};
  const count = data.pending.reduce((sum, row) => sum + row.count, 0);
  const facts = {
    '定时监控': data.health.enabled ? '已启用' : '已暂停',
    '最近检查': time(monitor.last_checked_at),
    '检查结果': results[monitor.last_result] || '尚未检查',
    '下次计划检查': data.health.enabled ? time(data.next_scheduled_at) : '等待恢复',
    '邮件配置': data.health.configured ? '已配置 SMTP / IMAP' : '配置不完整',
    '通知初始化': state.initialized ? '已完成' : '等待首次检查',
    '预测通知标记': state.active_watch_fingerprint ? '已有预测通知标记' : '无预测通知标记',
    '重置通知标记': state.notified_reset_id || '暂无',
    '标记更新时间': time(state.state_updated_at),
    '待处理通知': count + ' 条'
  };
  get('facts').replaceChildren();
  for (const [label, value] of Object.entries(facts)) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = String(value); get('facts').append(dt, dd);
  }
  get('pending').replaceChildren();
  if (!data.pending.length) get('pending').textContent = '暂无待处理通知。';
  for (const row of data.pending) {
    const item = document.createElement('div'); item.className = 'record';
    item.textContent = (kinds[row.kind] || row.kind) + ' · ' + (statuses[row.status] || row.status) + ' · ' + row.count + ' 条';
    get('pending').append(item);
  }
  get('history').replaceChildren();
  if (!data.recent.length) get('history').textContent = '暂无通知记录。导入前的邮件不在此列表中。';
  for (const row of data.recent) {
    const item = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
    item.className = 'record';
    title.textContent = (kinds[row.kind] || row.kind) + ' · ' + (statuses[row.status] || row.status);
    detail.textContent = '创建：' + time(row.created_at) + ' · 发送尝试 ' + row.attempts + ' 次';
    item.append(title, detail);
    if (row.attempted_at || row.completed_at) {
      const completed = document.createElement('p'); completed.className = 'hint';
      completed.textContent = '最近尝试：' + time(row.attempted_at) + ' · 完成：' + time(row.completed_at); item.append(completed);
    }
    if (row.last_error) {
      const error = document.createElement('p'); error.className = 'hint error';
      error.textContent = errors[row.last_error] || row.last_error; item.append(error);
    }
    get('history').append(item);
  }
  for (const id of ['overview', 'pendingSection', 'historySection', 'passwordSection']) get(id).hidden = false;
}
function clearSensitive() { document.querySelectorAll('input[type="password"]').forEach(input => input.value = ''); }
function renderAccess() {
  get('accessTitle').textContent = authenticated ? '管理访问' : passwordSet ? '管理登录' : '首次设置密码';
  get('accessHint').textContent = authenticated ? '使用完毕后请退出登录。' : passwordSet ? '使用你设置的密码登录。' : '当前尚未设置登录密码。';
  get('signedIn').hidden = !authenticated;
  get('loginForm').hidden = authenticated || !passwordSet || resetMode;
  get('setupForm').hidden = authenticated || passwordSet;
  get('forgot').hidden = authenticated || !passwordSet || resetMode;
  get('resetSection').hidden = authenticated || !passwordSet || !resetMode;
}
function signedOut() {
  authenticated = false; resetMode = false; accessVersion++;
  clearSensitive(); hidePrivate(); renderAccess();
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(200000)
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !['/auth/login', '/auth/setup', '/auth/reset'].includes(path)) signedOut();
    throw Error(response.status === 503 ? '服务暂时异常，请稍后查看状态或 Worker 日志' : result.error || '请求失败（' + response.status + '）');
  }
  return result;
}
async function busy(action, text) {
  document.querySelectorAll('button,input').forEach(control => control.disabled = true);
  message(text);
  try {
    await action();
  } catch (error) {
    message(error.name === 'TimeoutError' || error.name === 'TypeError' ? '连接中断或超时，请先刷新页面确认执行结果。' : error.message, true);
  } finally {
    document.querySelectorAll('button,input').forEach(control => control.disabled = false);
  }
}
async function act(path) {
  if (!authenticated) { message('请先登录。', true); return; }
  const version = accessVersion;
  await busy(async () => {
    const data = await api(path, path === '/status' ? 'GET' : 'POST');
    if (!authenticated || version !== accessVersion) return;
    if (path === '/status') { render(data); message('状态已更新'); return; }
    const summary = path === '/verify-mail' ? 'SMTP / IMAP 连接验证通过，未发送测试邮件。' :
      (results[data.result] || data.result) + '；已提交 ' + data.sent + ' 封，暂缓 ' + data.deferred + ' 项，失败 ' + data.failed + ' 项。';
    try {
      const status = await api('/status');
      if (!authenticated || version !== accessVersion) return;
      render(status);
    }
    catch { message(summary + ' 状态刷新失败，请重新查看状态。', true); return; }
    message(summary, path === '/check' && data.result !== 'ok');
  }, path === '/status' ? '正在读取状态…' : path === '/check' ? '正在检查，可能需要几分钟…' : '正在验证邮件连接…');
}
function newPassword(first, confirm) {
  const value = get(first).value;
  if (value.length < 6 || value.length > 128) throw Error('新密码须为 6–128 个字符。');
  if (value !== get(confirm).value) throw Error('两次输入的新密码不一致。');
  return value;
}
get('loginForm').addEventListener('submit', event => {
  event.preventDefault();
  const value = get('password').value;
  void busy(async () => {
    try {
      await api('/auth/login', 'POST', { password: value });
      authenticated = true; resetMode = false; accessVersion++; renderAccess();
      try { render(await api('/status')); message('登录成功，状态已更新。'); }
      catch (error) { message('登录请求已完成，状态读取失败：' + error.message, true); }
    } finally { clearSensitive(); }
  }, '正在登录…');
});
for (const [form, path, first, confirm, code] of [
  ['setupForm', '/auth/setup', 'setupPassword', 'setupConfirm', 'setupCode'],
  ['resetForm', '/auth/reset', 'resetPassword', 'resetConfirm', 'resetCode'],
  ['changeForm', '/auth/password', 'newPassword', 'newConfirm', null]
]) {
  get(form).addEventListener('submit', event => {
    event.preventDefault();
    let value;
    try { value = newPassword(first, confirm); } catch (error) { message(error.message, true); return; }
    const body = { newPassword: value };
    if (code) body.recoveryCode = get(code).value.trim();
    else body.currentPassword = get('currentPassword').value;
    void busy(async () => {
      try {
        const result = await api(path, 'POST', body);
        passwordSet = true; signedOut(); message(result.message);
      } finally { clearSensitive(); }
    }, '正在保存密码…');
  });
}
get('load').addEventListener('click', () => { void act('/status'); });
get('run').addEventListener('click', () => { void act('/check'); });
get('verify').addEventListener('click', () => { void act('/verify-mail'); });
get('logout').addEventListener('click', () => {
  void busy(async () => { const result = await api('/auth/logout', 'POST'); signedOut(); message(result.message); }, '正在退出…');
});
get('forgot').addEventListener('click', () => { resetMode = true; clearSensitive(); renderAccess(); message(''); });
get('back').addEventListener('click', () => { resetMode = false; clearSensitive(); renderAccess(); message(''); });
window.addEventListener('pagehide', () => { accessVersion++; clearSensitive(); hidePrivate(); });
window.addEventListener('pageshow', event => { if (event.persisted) void loadAccess(); });
async function loadAccess() {
  try {
    const status = await api('/auth/status');
    passwordSet = status.password_set; authenticated = status.authenticated; resetMode = false; renderAccess();
    if (authenticated) render(await api('/status'));
  } catch (error) { message('无法读取登录状态：' + error.message, true); }
}
async function loadHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('health unavailable');
    renderHealth(await response.json());
  } catch { get('service').textContent = '暂时无法读取服务状态，请稍后刷新页面。'; get('service').className = 'error'; }
}
void loadHealth();
void loadAccess();
`;
