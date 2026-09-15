import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';

if (process.argv.includes('--fixture')) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chat_missions(id TEXT PRIMARY KEY,channel_id TEXT,coordinator_registration_id TEXT,root_message_id TEXT,created_by INTEGER);
    CREATE TABLE chat_mission_tasks(id TEXT PRIMARY KEY,mission_id TEXT,status TEXT,dispatch_id TEXT,run_id INTEGER);
    CREATE TABLE chat_messages(id TEXT PRIMARY KEY,mission_task_id TEXT);
    CREATE TABLE chat_agent_dispatches(id TEXT PRIMARY KEY,channel_id TEXT,registration_id TEXT,message_id TEXT,run_id INTEGER,failed_at TEXT,error TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,chat_dispatch_id TEXT UNIQUE,status TEXT,owner_user_id INTEGER);
    CREATE TABLE chat_mission_interpretations(mission_id TEXT PRIMARY KEY,dispatch_id TEXT);
    CREATE TABLE chat_mission_cancellation_replays(run_id INTEGER PRIMARY KEY,mission_id TEXT,dispatch_id TEXT,owner_user_id INTEGER,reason TEXT);
    CREATE INDEX message_task ON chat_messages(mission_task_id);
    CREATE INDEX dispatch_message ON chat_agent_dispatches(message_id);
    CREATE INDEX dispatch_channel ON chat_agent_dispatches(channel_id,registration_id);
  `);
  db.transaction(() => {
    const message = db.prepare('INSERT INTO chat_messages VALUES(?,?)');
    for (let i = 0; i < 8229; i++) message.run(`msg${i}`, `t${i % 346}`);
    const dispatch = db.prepare("INSERT INTO chat_agent_dispatches VALUES(?,'channel','agent',?,?,NULL,NULL)");
    for (let i = 0; i < 2675; i++) dispatch.run(`d${i}`, `msg${i}`, i + 1);
    const run = db.prepare('INSERT INTO runs VALUES(?,?,?,1)');
    for (let i = 0; i < 3959; i++) run.run(i + 1, `d${i}`, i % 100 === 0 ? 'running' : 'completed');
    const mission = db.prepare("INSERT INTO chat_missions VALUES(?,'channel','agent',?,1)");
    for (let i = 0; i < 305; i++) mission.run(`m${i}`, `msg${i}`);
    const task = db.prepare("INSERT INTO chat_mission_tasks VALUES(?,?,'canceled',?,?)");
    for (let i = 0; i < 346; i++) task.run(`t${i}`, `m${i % 305}`, `d${i}`, i + 1);
  })();
  const source = fs.readFileSync(new URL('../backend_elixir/lib/cascade/missions/schema.ex', import.meta.url), 'utf8');
  const helper = source.match(/defp coordinator_dispatch_links_sql do\s+"""([\s\S]*?)"""/)[1];
  for (const name of ['persist_task_cancellation_replays!', 'persist_coordinator_cancellation_replays!', 'fence_historical_dispatches!']) {
    const query = source.match(new RegExp(`defp ${name} do\\s+SQL.exec\\("""([\\s\\S]*?)"""\\)`))[1]
      .replace('#{coordinator_dispatch_links_sql()}', helper);
    db.exec(query);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_mission_cancellation_replays').get().n, 27);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_agent_dispatches WHERE failed_at IS NOT NULL').get().n, 27);
  db.close();
} else {
  test('migration cancels the expected active runs at production-sized scale', () => {
    // A subprocess deadline also bounds a native SQLite query that blocks JS.
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--fixture'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  });
}
