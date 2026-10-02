import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args.length !== 2 || !['--local', '--remote'].includes(args[0])) throw new Error('Usage: npm run import-state -- --local|--remote state.json');
const state = JSON.parse(await readFile(args[1], 'utf8'));
const keys = ['active_watch_fingerprint','initialized','notified_reset_id','state_updated_at','version'];
if (!state || typeof state !== 'object' || Object.keys(state).sort().join() !== keys.join() || state.version !== 1 || typeof state.initialized !== 'boolean' ||
    keys.filter(k => !['version','initialized'].includes(k)).some(k => state[k] !== null && typeof state[k] !== 'string')) throw new Error('Invalid public monitor state');
await mkdir('.wrangler', { recursive: true });
const filename = resolve('.wrangler', `import-state-${randomUUID()}.sql`);
const value = JSON.stringify(state).replaceAll("'", "''");
// Import once only, before live notification work. Never reset existing D1 state.
await writeFile(filename, `UPDATE monitor SET state_json = '${value}' WHERE id = 1 AND json_extract(state_json, '$.initialized') = 0 AND lease_until <= ${Date.now()} AND NOT EXISTS (SELECT 1 FROM notifications);\n`, { mode: 0o600 });
try {
  const result = spawnSync(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'codex-resets-monitor', args[0], '--file', filename, '--yes'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('State import failed');
} finally { await unlink(filename); }
