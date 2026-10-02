import { readFile } from 'node:fs/promises';

const [action = 'status'] = process.argv.slice(2);
if (!['status','check','verify-mail'].includes(action)) throw new Error('Usage: npm run admin -- status|check|verify-mail');
const token = process.env.ADMIN_TOKEN || (await readFile('.wrangler/admin-token', 'utf8')).trim();
const base = process.env.MONITOR_URL || 'https://codex-resets-monitor.turmony.workers.dev';
const response = await fetch(`${base}/${action}`, {
  method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(200000),
});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
