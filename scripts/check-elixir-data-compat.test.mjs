import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  databaseSnapshot,
  materializeSchemaFingerprint,
  compareSchemaFingerprints,
  parseArgs,
  readSchemaFingerprint,
  runComparison,
} from './check-elixir-data-compat.mjs';

test('new tables roll forward without a data audit while destructive schema changes fail', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1)');
    const fingerprint = () => ({ objects: db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all(), migrations: [] });
    const before = fingerprint();
    db.exec(`CREATE TABLE app_context(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, revision TEXT NOT NULL);
      CREATE INDEX app_context_revision ON app_context(revision)`);
    const after = fingerprint();
    assert.deepEqual(compareSchemaFingerprints(before, after), []);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(), [{id: 1}]);
    assert.deepEqual(compareSchemaFingerprints(after, before), ['database schema changed']);
    db.exec('CREATE TRIGGER app_context_delete AFTER INSERT ON app_context BEGIN DELETE FROM users; END');
    assert.deepEqual(compareSchemaFingerprints(after, fingerprint()), ['database schema changed']);
    db.exec('DROP TRIGGER app_context_delete; ALTER TABLE users ADD COLUMN required TEXT NOT NULL DEFAULT "new constraint"');
    assert.deepEqual(compareSchemaFingerprints(after, fingerprint()), ['database schema changed']);
  } finally { db.close(); }
});

test('rolling schema classification permits only the pinned agent flag transitions', () => {
  const base = { type: 'table', name: 'chat_agent_members', tableName: 'chat_agent_members', sql: "CREATE TABLE \"chat_agent_members\" ( id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '', mention TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '', priority_service_tier INTEGER NOT NULL DEFAULT 0, cwd TEXT NOT NULL DEFAULT '', context_prompt TEXT NOT NULL DEFAULT '', taggable_by_agents INTEGER NOT NULL DEFAULT 0, reply_to_every_message INTEGER NOT NULL DEFAULT 0, orchestrator INTEGER NOT NULL DEFAULT 0, pingable_by_others INTEGER NOT NULL DEFAULT 0, yolo INTEGER NOT NULL DEFAULT 0, conversation_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), vault_agent_id TEXT NOT NULL DEFAULT '' )" };
  const ambient = { ...base, sql: base.sql.replace('yolo INTEGER', 'ambient_group_chat INTEGER NOT NULL DEFAULT 0, yolo INTEGER') };
  assert.deepEqual(compareSchemaFingerprints(
    { objects: [base], migrations: [] },
    { objects: [ambient], migrations: [] },
  ), []);

  const finalOnly = { ...ambient, sql: ambient.sql.replace('yolo INTEGER', 'final_reply_only INTEGER NOT NULL DEFAULT 0, yolo INTEGER') };
  assert.deepEqual(compareSchemaFingerprints(
    { objects: [ambient], migrations: [] },
    { objects: [finalOnly], migrations: [] },
  ), []);

  const suggestions = { ...finalOnly, sql: finalOnly.sql.replace("conversation_id TEXT", "next_step_suggestions INTEGER NOT NULL DEFAULT 0, conversation_id TEXT") };
  assert.deepEqual(compareSchemaFingerprints(
    { objects: [finalOnly], migrations: [] },
    { objects: [suggestions], migrations: [] },
  ), []);
  assert.deepEqual(compareSchemaFingerprints(
    { objects: [suggestions], migrations: [] },
    { objects: [finalOnly], migrations: [] },
  ), ['database schema changed']);

  const unknown = { ...finalOnly, sql: finalOnly.sql.replace('DEFAULT 0, yolo', 'DEFAULT 1, yolo') };
  assert.deepEqual(compareSchemaFingerprints(
    { objects: [ambient], migrations: [] },
    { objects: [unknown], migrations: [] },
  ), ['database schema changed']);
  assert.deepEqual(compareSchemaFingerprints(
    { objects: [ambient], migrations: [] },
    { objects: [base], migrations: [] },
  ), ['database schema changed']);
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-data-compat-'));
  const before = path.join(directory, 'before.db');
  const after = path.join(directory, 'after.db');
  const beforeRoot = path.join(directory, 'before-vaults');
  const afterRoot = path.join(directory, 'after-vaults');
  fs.mkdirSync(beforeRoot);
  fs.mkdirSync(afterRoot);
  const db = new Database(before);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL
    );
    CREATE INDEX notes_user_idx ON notes(user_id);
    CREATE TRIGGER notes_nonempty BEFORE INSERT ON notes
    WHEN NEW.body = '' BEGIN SELECT RAISE(ABORT, 'empty'); END;
    INSERT INTO users VALUES (1, 'sol');
    INSERT INTO notes VALUES ('note-1', 1, 'hello');
  `);
  db.close();
  fs.copyFileSync(before, after);
  fs.writeFileSync(path.join(beforeRoot, 'General.md'), '# General\n');
  fs.copyFileSync(path.join(beforeRoot, 'General.md'), path.join(afterRoot, 'General.md'));
  return { directory, before, after, beforeRoot, afterRoot };
}

test('permits only the additive Elixir migration ledger', () => {
  const files = fixture();
  try {
    const db = new Database(files.after);
    db.exec(`
      CREATE TABLE cascade_elixir_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO cascade_elixir_schema_migrations(version,name,checksum)
      VALUES (
        1,
        'core_node_schema_compatibility',
        'b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a'
      );
    `);
    db.close();
    const result = runComparison(files);
    assert.equal(result.ok, true, result.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('permits only pinned additive agent identity columns with default values', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec(`
      CREATE TABLE vaults (id TEXT PRIMARY KEY);
      INSERT INTO vaults VALUES ('general');
      CREATE TABLE vault_agents (
        id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL, display_name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '',
        mention TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '',
        context_prompt TEXT NOT NULL DEFAULT '', owner_user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_user_id,mention)
      );
      INSERT INTO vault_agents VALUES ('sol','general','codex','Sol','','sol','','','',1,datetime('now'),datetime('now'));
    `);
    before.close();
    fs.copyFileSync(files.before, files.after);

    const after = new Database(files.after);
    after.exec(`
      ALTER TABLE vault_agents ADD COLUMN hermes_profile TEXT NOT NULL DEFAULT '';
      ALTER TABLE vault_agents ADD COLUMN hermes_safe_mode INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vault_agents ADD COLUMN identity_scope TEXT NOT NULL DEFAULT 'network';
      ALTER TABLE vault_agents ADD COLUMN expires_at TEXT;
    `);
    after.close();
    assert.equal(runComparison(files).ok, true, runComparison(files).failures.join('\n'));

    const changed = new Database(files.after);
    changed.prepare('UPDATE vault_agents SET hermes_profile = ? WHERE id = ?').run('unexpected', 'sol');
    changed.close();
    assert.ok(runComparison(files).failures.some((failure) => (
      failure.startsWith('table changed outside pinned agent identity migration: vault_agents')
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('permits only the additive default-shared mission workspace migration', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec(`
      CREATE TABLE chat_mission_tasks (
        id TEXT PRIMARY KEY,
        run_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      INSERT INTO chat_mission_tasks VALUES
        ('task-1', 900, 'running'),
        ('task-2', NULL, 'pending');
    `);
    before.close();
    fs.copyFileSync(files.before, files.after);

    const after = new Database(files.after);
    after.exec("ALTER TABLE chat_mission_tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared'");
    after.close();
    assert.equal(runComparison(files).ok, true, runComparison(files).failures.join('\n'));

    const changed = new Database(files.after);
    changed.prepare('UPDATE chat_mission_tasks SET workspace_mode = ? WHERE id = ?')
      .run('isolated', 'task-1');
    changed.close();
    assert.ok(runComparison(files).failures.some((failure) => (
      failure.startsWith('table changed: chat_mission_tasks')
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('mission recovery migration preserves rows and cannot backfill authority or evidence', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec("CREATE TABLE chat_missions (id TEXT PRIMARY KEY, summary TEXT, UNIQUE(id,summary)); INSERT INTO chat_missions VALUES ('m1','pending review')");
    before.close();
    fs.copyFileSync(files.before, files.after);
    const after = new Database(files.after);
    after.exec(`
      ALTER TABLE chat_missions ADD COLUMN authority_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE chat_missions ADD COLUMN verification TEXT NOT NULL DEFAULT '';
      ALTER TABLE chat_missions ADD COLUMN review_attempt INTEGER NOT NULL DEFAULT 0;
    `);
    after.close();
    assert.equal(runComparison(files).ok, true, runComparison(files).failures.join('\n'));
    for (const [column, value] of [['authority_json', '["deploy"]'], ['verification', 'claimed'], ['review_attempt', 1], ['summary', 'changed']]) {
      const changed = new Database(files.after);
      const original = changed.prepare(`SELECT ${column} AS value FROM chat_missions`).get().value;
      changed.prepare(`UPDATE chat_missions SET ${column}=?`).run(value);
      changed.close();
      assert.equal(runComparison(files).ok, false, column);
      const restored = new Database(files.after);
      restored.prepare(`UPDATE chat_missions SET ${column}=?`).run(original);
      restored.close();
    }
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('state-based recovery migration preserves failed history and rejects invented evidence', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec("CREATE TABLE chat_missions (id TEXT PRIMARY KEY, summary TEXT, review_attempt INTEGER NOT NULL DEFAULT 0); INSERT INTO chat_missions VALUES ('m1','heartbeat expired',3); CREATE TABLE chat_mission_tasks (id TEXT PRIMARY KEY,run_id INTEGER); INSERT INTO chat_mission_tasks VALUES ('t',NULL),('s',NULL)");
    before.close();
    fs.copyFileSync(files.before, files.after);
    const after = new Database(files.after);
    after.exec("ALTER TABLE chat_missions ADD COLUMN review_fingerprint TEXT NOT NULL DEFAULT ''");
    const schema = fs.readFileSync(new URL('../backend_elixir/lib/cascade/missions/schema.ex', import.meta.url), 'utf8');
    const ddl = schema.match(/CREATE TABLE IF NOT EXISTS chat_mission_recovery_evidence \([\s\S]*?\n    \)/)[0];
    after.exec(ddl);
    after.close();
    assert.equal(runComparison(files).ok, true, runComparison(files).failures.join('\n'));
    for (const [column, value] of [['review_fingerprint', 'claimed'], ['summary', 'completed'], ['review_attempt', 0]]) {
      const changed = new Database(files.after);
      const original = changed.prepare(`SELECT ${column} AS value FROM chat_missions`).get().value;
      changed.prepare(`UPDATE chat_missions SET ${column}=?`).run(value);
      changed.close();
      assert.equal(runComparison(files).ok, false, column);
      const restored = new Database(files.after);
      restored.prepare(`UPDATE chat_missions SET ${column}=?`).run(original);
      restored.close();
    }
    const changed = new Database(files.after);
    changed.pragma('foreign_keys = OFF');
    changed.exec("INSERT INTO chat_mission_recovery_evidence (task_id,source_task_id,target_snapshot,source_snapshot,verification,coordinator_registration_id) VALUES ('t','s','t','s','invented','c')");
    changed.close();
    assert.equal(runComparison(files).ok, false);
    const malformed = new Database(files.after);
    malformed.exec('DELETE FROM chat_mission_recovery_evidence; ALTER TABLE chat_mission_recovery_evidence ADD COLUMN unreviewed TEXT');
    malformed.close();
    assert.equal(runComparison(files).ok, false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('next-step checkpoint migration only permits the reviewed empty table', () => {
  const files = fixture();
  try {
    const schema = fs.readFileSync(new URL('../backend_elixir/lib/cascade/chat/schema.ex', import.meta.url), 'utf8');
    const ddl = schema.match(/CREATE TABLE IF NOT EXISTS chat_next_step_checks \([\s\S]*?\n    \)/)[0];
    const after = new Database(files.after);
    after.exec(ddl);
    after.close();
    assert.equal(runComparison(files).ok, true, runComparison(files).failures.join('\n'));
    const changed = new Database(files.after);
    changed.pragma('foreign_keys = OFF');
    changed.exec("INSERT INTO chat_next_step_checks(channel_id,registration_id,source_id,kind) VALUES('note-1','r','s','enable')");
    changed.close();
    assert.equal(runComparison(files).ok, false);
    const malformed = new Database(files.after);
    malformed.exec('DELETE FROM chat_next_step_checks; ALTER TABLE chat_next_step_checks ADD COLUMN unreviewed TEXT');
    malformed.close();
    assert.equal(runComparison(files).ok, false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('app context migration only permits the reviewed empty table', () => {
  const files = fixture();
  try {
    const schema = fs.readFileSync(new URL('../backend_elixir/lib/cascade/accounts/schema.ex', import.meta.url), 'utf8');
    const ddl = schema.match(/CREATE TABLE IF NOT EXISTS app_context \([\s\S]*?\n    \)/)[0];
    const after = new Database(files.after);
    after.exec(ddl);
    after.close();
    assert.equal(runComparison(files).ok, true, runComparison(files).failures.join('\n'));
    const changed = new Database(files.after);
    changed.pragma('foreign_keys = OFF');
    changed.exec("INSERT INTO app_context(user_id,content,revision) VALUES(1,'guidance','r')");
    changed.close();
    assert.equal(runComparison(files).ok, false);
    const malformed = new Database(files.after);
    malformed.exec('DELETE FROM app_context; ALTER TABLE app_context ADD COLUMN unreviewed TEXT');
    malformed.close();
    assert.equal(runComparison(files).ok, false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

function dispatchAdmissionFixture() {
  const files = chatBackfillFixture();
  normalizeChatMessages(files.before, 'mission_task_id');
  const schema = fs.readFileSync(new URL('../backend_elixir/lib/cascade/missions/schema.ex', import.meta.url), 'utf8');
  const ddl = schema.match(/CREATE TABLE IF NOT EXISTS chat_agent_dispatches \([\s\S]*?\n    \)/u)?.[0];
  const columns = schema.match(/for \{name, definition\} <- \[([\s\S]*?)\] do\s+SQL.ensure_column\("chat_agent_dispatches"/u)?.[1];
  assert.ok(ddl && columns, 'current dispatch schema and admission additions must be present');
  const additions = [...columns.matchAll(/\{"([^"]+)", "([^"]+)"\}/gu)]
    .map(([, name, definition]) => `ALTER TABLE chat_agent_dispatches ADD COLUMN ${name} ${definition};`)
    .join('\n');
  const db = new Database(files.before);
  db.exec(ddl);
  db.exec(`
    CREATE INDEX chat_agent_dispatches_pending_idx ON chat_agent_dispatches(channel_id, run_id, created_at);
    INSERT INTO chat_agent_dispatches(rowid,id,message_id,channel_id,registration_id,run_id,reasoning_effort,created_at)
    VALUES (41,'dispatch-z','message-1','note-1','agent-1',900,'high','2026-08-11 00:00:00'),
           (97,'dispatch-a','message-1','note-1','agent-2',NULL,'','2026-08-12 00:00:00');
  `);
  db.close();
  fs.copyFileSync(files.before, files.after);
  return { ...files, additions };
}

test('dispatch admission migration preserves rows and materialized schemas but requires maintenance', async (t) => {
  for (const materialized of [false, true]) {
    await t.test(materialized ? 'materialized old schema' : 'historical rows and rowids', () => {
      const files = dispatchAdmissionFixture();
      try {
        if (materialized) {
          materializeSchemaFingerprint(readSchemaFingerprint(files.before), files.before);
          fs.copyFileSync(files.before, files.after);
        }
        const db = new Database(files.after);
        db.exec(files.additions);
        db.close();
        const result = runComparison(files);
        assert.equal(result.ok, true, result.failures.join('\n'));
        assert.equal(runComparison({ ...files, requireIdentical: true }).ok, false);
        assert.deepEqual(runComparison({ ...files, schemaOnly: true }).failures, ['database schema changed']);
        assert.equal(runComparison({ ...files, before: files.after }).ok, true);
      } finally {
        fs.rmSync(files.directory, { recursive: true, force: true });
      }
    });
  }
});

test('dispatch admission migration rejects schema, default, backfill, and historical data drift', async (t) => {
  const changes = {
    'wrong type': (sql) => sql.replace('requester_channel_id TEXT', 'requester_channel_id INTEGER'),
    'wrong default': (sql) => sql.replace('conversation_id TEXT', "conversation_id TEXT DEFAULT ''"),
    'wrong nullability': (sql) => sql.replace('error TEXT', "error TEXT NOT NULL DEFAULT ''"),
    'missing foreign key': (sql) => sql.replace('INTEGER REFERENCES users(id)', 'INTEGER'),
    'wrong foreign key action': (sql) => sql.replace('REFERENCES users(id)', 'REFERENCES users(id) ON DELETE CASCADE'),
    'missing column': (sql) => sql.replace(/ALTER TABLE chat_agent_dispatches ADD COLUMN failed_at TEXT;/u, ''),
    'extra column': (sql) => `${sql} ALTER TABLE chat_agent_dispatches ADD COLUMN unreviewed TEXT;`,
    'historical value': (sql) => `${sql} UPDATE chat_agent_dispatches SET reasoning_effort='low';`,
    'historical rowid': (sql) => `${sql} UPDATE chat_agent_dispatches SET rowid=rowid+100;`,
    'removed row': (sql) => `${sql} DELETE FROM chat_agent_dispatches WHERE id='dispatch-a';`,
    ...Object.fromEntries([
      ['requester_user_id', '1'], ['requester_channel_id', "'note-1'"],
      ['target_owner_user_id', '1'], ['target_identity_id', "'agent-1'"],
      ['conversation_id', "''"], ['error', "''"], ['failed_at', "'2026-08-11'"],
    ].map(([column, value]) => [`${column} backfill`, (sql) => (
      `${sql} UPDATE chat_agent_dispatches SET ${column}=${value} WHERE id='dispatch-a';`
    )])),
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, () => {
      const files = dispatchAdmissionFixture();
      try {
        const db = new Database(files.after);
        db.exec(change(files.additions));
        db.close();
        const result = runComparison(files);
        assert.ok(result.failures.some((failure) => failure.startsWith('table changed: chat_agent_dispatches')));
      } finally {
        fs.rmSync(files.directory, { recursive: true, force: true });
      }
    });

  }
});

function deliveryFixture() {
  const files = fixture();
  const schema = fs.readFileSync(new URL('../backend_elixir/lib/cascade/runs/schema.ex', import.meta.url), 'utf8');
  const ddl = schema.match(/CREATE TABLE IF NOT EXISTS delegated_runs \([\s\S]*?\n    \)/u)?.[0];
  const additions = [...schema.matchAll(/SQL.ensure_column\("delegated_runs", "([^"]+)", "([^"]+)"\)/gu)]
    .map(([, name, definition]) => `ALTER TABLE delegated_runs ADD COLUMN ${name} ${definition};`).join('\n');
  assert.ok(ddl && additions);
  const db = new Database(files.before);
  db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY,owner_user_id INTEGER); INSERT INTO runs VALUES (10,1),(12,2); ${ddl};
    INSERT INTO delegated_runs(run_id,owner_user_id,started_at) VALUES (10,1,'2026-09-05 10:00:00'),(12,2,'2026-09-05 11:00:00');`);
  db.close();
  fs.copyFileSync(files.before, files.after);
  return { ...files, additions };
}

test('delivery migration preserves historical leases and permits only empty default state', async t => {
  const cases = {
    historical: sql => sql,
    materialized: sql => sql,
    'wrong type': sql => sql.replace('delivery_sent_at TEXT', 'delivery_sent_at INTEGER'),
    'wrong default': sql => sql.replace('DEFAULT 0', 'DEFAULT 1'),
    'missing column': sql => sql.replace(/ALTER TABLE delegated_runs ADD COLUMN delivery_sent_at TEXT;/u, ''),
    'extra column': sql => `${sql} ALTER TABLE delegated_runs ADD COLUMN unrelated TEXT;`,
    'owner changed': sql => `${sql} UPDATE delegated_runs SET owner_user_id=7 WHERE run_id=10;`,
    'timestamp changed': sql => `${sql} UPDATE delegated_runs SET started_at='changed' WHERE run_id=10;`,
    'row removed': sql => `${sql} DELETE FROM delegated_runs WHERE run_id=10;`,
    'payload backfilled': sql => `${sql} UPDATE delegated_runs SET delivery_payload_json='{}' WHERE run_id=10;`,
    'sent timestamp backfilled': sql => `${sql} UPDATE delegated_runs SET delivery_sent_at='now' WHERE run_id=10;`,
    'attempts backfilled': sql => `${sql} UPDATE delegated_runs SET delivery_attempts=1 WHERE run_id=10;`,
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
    const files = deliveryFixture();
    try {
      if (name === 'materialized') {
        materializeSchemaFingerprint(readSchemaFingerprint(files.before), files.before);
        fs.copyFileSync(files.before, files.after);
      }
      const db = new Database(files.after);
      db.exec(change(files.additions));
      db.close();
      const result = runComparison(files);
      const valid = name === 'historical' || name === 'materialized';
      assert.equal(result.ok, valid, result.failures.join('\n'));
      if (valid) {
        assert.equal(runComparison({ ...files, requireIdentical: true }).ok, false);
        assert.deepEqual(runComparison({ ...files, schemaOnly: true }).failures, ['database schema changed']);
        assert.equal(runComparison({ ...files, before: files.after }).ok, true);
      }
    } finally {
      fs.rmSync(files.directory, { recursive: true, force: true });
    }
  });
});

test('rolling eligibility requires exact data and corpus identity', () => {
  const files = fixture();
  try {
    assert.equal(runComparison({ ...files, requireIdentical: true }).ok, true);

    const db = new Database(files.after);
    db.exec(`
      CREATE TABLE cascade_elixir_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO cascade_elixir_schema_migrations(version,name,checksum)
      VALUES (
        1,
        'core_node_schema_compatibility',
        'b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a'
      );
    `);
    db.close();
    assert.equal(runComparison(files).ok, true);
    const rolling = runComparison({ ...files, requireIdentical: true });
    assert.equal(rolling.ok, false);
    assert.ok(rolling.failures.includes('table added: cascade_elixir_schema_migrations'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rolling eligibility ignores only valid FTS5 physical index repacking', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec(`
      CREATE VIRTUAL TABLE notes_fts USING fts5(body);
      INSERT INTO notes_fts(rowid,body) VALUES (1,'alpha beta');
    `);
    before.close();
    fs.copyFileSync(files.before, files.after);

    const after = new Database(files.after);
    after.exec(`
      INSERT INTO notes_fts(rowid,body) VALUES (2,'temporary segment');
      DELETE FROM notes_fts WHERE rowid=2;
      INSERT INTO notes_fts(notes_fts) VALUES('optimize');
    `);
    after.close();

    const beforeSnapshot = databaseSnapshot(files.before);
    const afterSnapshot = databaseSnapshot(files.after);
    assert.notEqual(
      beforeSnapshot.tables.notes_fts_data.rows.sha256,
      afterSnapshot.tables.notes_fts_data.rows.sha256,
    );
    const rolling = runComparison({ ...files, requireIdentical: true });
    assert.equal(rolling.ok, true, rolling.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rolling live verification permits row churn but rejects schema drift', () => {
  const files = fixture();
  try {
    const db = new Database(files.after);
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run('live write', 'note-1');
    db.close();
    assert.equal(runComparison({ ...files, schemaOnly: true }).ok, true);

    const changed = new Database(files.after);
    changed.exec('CREATE INDEX notes_body_idx ON notes(body)');
    changed.close();
    const result = runComparison({ ...files, schemaOnly: true });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('database schema changed'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('schema fingerprints ignore row bodies and rematerialize DDL only', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec(`
      CREATE TABLE cascade_elixir_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO cascade_elixir_schema_migrations(version,name,checksum)
      VALUES (1, 'core_node_schema_compatibility', 'b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a');
    `);
    before.close();
    const fingerprint = readSchemaFingerprint(files.before);
    const clone = path.join(files.directory, 'schema-only.db');
    materializeSchemaFingerprint(fingerprint, clone);
    const cloneDb = new Database(clone);
    assert.deepEqual(
      cloneDb.prepare('SELECT COUNT(*) AS count FROM notes').get(),
      { count: 0 },
    );
    assert.deepEqual(
      cloneDb.prepare('SELECT version, name, checksum FROM cascade_elixir_schema_migrations').all(),
      fingerprint.migrations,
    );
    cloneDb.close();
    assert.equal(runComparison({ beforeSchema: files.before, after: clone, schemaOnly: true }).ok, true);

    const writer = new Database(files.before);
    writer.prepare('INSERT INTO notes VALUES (?, ?, ?)').run('note-2', 1, 'more');
    writer.close();
    assert.equal(runComparison({ before: files.before, after: clone, schemaOnly: true }).ok, true);

    const fts = new Database(files.before);
    fts.exec(`CREATE VIRTUAL TABLE notes_fts USING fts5(body); INSERT INTO notes_fts(rowid,body) VALUES (1,'hello');`);
    fts.close();
    const ftsFingerprint = readSchemaFingerprint(files.before);
    assert.equal(ftsFingerprint.objects.some((object) => object.name === 'notes_fts'), true);
    assert.equal(ftsFingerprint.objects.some((object) => object.name.endsWith('_config')), false);
    const ftsClone = path.join(files.directory, 'fts-schema.db');
    materializeSchemaFingerprint(ftsFingerprint, ftsClone);
    assert.equal(runComparison({ before: files.before, after: ftsClone, schemaOnly: true }).ok, true);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rolling CLI modes are value-free and mutually exclusive', () => {
  const strict = parseArgs(['--before', 'before.db', '--after', 'after.db', '--require-identical']);
  assert.equal(strict.requireIdentical, true);
  assert.equal(strict.schemaOnly, false);
  assert.throws(
    () => parseArgs([
      '--before', 'before.db', '--after', 'after.db', '--require-identical', '--schema-only',
    ]),
    /mutually exclusive/,
  );
});

test('schema snapshots never create WAL or SHM beside an authoritative database', () => {
  const files = fixture();
  try {
    const writer = new Database(files.before);
    assert.equal(writer.pragma('journal_mode = WAL', { simple: true }), 'wal');
    writer.prepare('UPDATE notes SET body = body WHERE id = ?').run('note-1');
    assert.deepEqual(writer.pragma('wal_checkpoint(TRUNCATE)'), [{ busy: 0, log: 0, checkpointed: 0 }]);
    writer.close();
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(`${files.before}${suffix}`); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    fs.copyFileSync(files.before, files.after);
    assert.equal(fs.existsSync(`${files.before}-wal`), false);
    assert.equal(fs.existsSync(`${files.before}-shm`), false);
    const snapshot = databaseSnapshot(files.before);
    assert.equal(snapshot.quickCheck, 'ok');
    assert.equal(runComparison(files).ok, true);
    assert.equal(fs.existsSync(`${files.before}-wal`), false);
    assert.equal(fs.existsSync(`${files.before}-shm`), false);
    assert.equal(fs.existsSync(`${files.after}-wal`), false);
    assert.equal(fs.existsSync(`${files.after}-shm`), false);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects candidate-only ordinary application tables', () => {
  const files = fixture();
  try {
    const db = new Database(files.after);
    db.exec('CREATE TABLE plausible_application_state (id INTEGER PRIMARY KEY, value TEXT)');
    db.close();
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('unexpected table added: plausible_application_state'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

function normalizationFixture() {
  const files = fixture();
  const db = new Database(files.before);
  db.exec(`
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vault_members (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('owner','editor','viewer')),
      invited_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (vault_id, user_id)
    );
    INSERT INTO vaults(id,name,root_path,created_by,created_at)
      VALUES('vault-1','Vault','/tmp/vault-1',1,'2026-08-11 00:00:00');
    INSERT INTO vault_members(rowid,vault_id,user_id,role,invited_by,created_at)
      VALUES(41,'vault-1',1,'owner',NULL,'2026-08-11 00:00:00');
  `);
  db.close();
  fs.copyFileSync(files.before, files.after);
  return files;
}

function normalizeVaultMembers(filename, preserveRowid = true) {
  const db = new Database(filename);
  db.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE vault_members_next (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('owner','editor','viewer')),
      invited_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (vault_id, user_id)
    );
    INSERT INTO vault_members_next(${preserveRowid ? 'rowid,' : ''}vault_id,user_id,role,invited_by,created_at)
      SELECT ${preserveRowid ? 'rowid,' : ''}vault_id,user_id,role,invited_by,created_at FROM vault_members;
    DROP TABLE vault_members;
    ALTER TABLE vault_members_next RENAME TO vault_members;
    PRAGMA foreign_keys=ON;
  `);
  db.close();
}

function chatBackfillFixture() {
  const files = fixture();
  const before = new Database(files.before);
  before.exec(`
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    INSERT INTO vaults VALUES('vault-1','Vault','/tmp/vault-1',1,'2026-08-11 00:00:00');
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')),
      status TEXT,agent_id TEXT,registration_id TEXT,run_id INTEGER,blocks_json TEXT,images_json TEXT,
      attachments_json TEXT,reply_to_json TEXT,harness_log TEXT,change_request_json TEXT,
      forwarded_from_json TEXT,mission_json TEXT,mission_task_id TEXT,clarification_json TEXT,
      activity_at TEXT,actor_user_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE chat_mission_tasks (id TEXT PRIMARY KEY,run_id INTEGER);
    INSERT INTO chat_mission_tasks VALUES('task-1',900),('task-2',900);
    INSERT INTO chat_messages(
      rowid,id,channel_id,vault_id,author,body,created_at,run_id,mission_json
    ) VALUES(
      41,'message-1','note-1','vault-1','Sol','done','2026-08-11 00:00:00',900,
      '{"id":"mission-1","status":"active"}'
    );
  `);
  before.close();
  fs.copyFileSync(files.before, files.after);
  return files;
}

function normalizeChatMessages(filename, missionTaskExpression) {
  const db = new Database(filename);
  db.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE chat_messages_next (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      activity_at TEXT, actor_user_id INTEGER REFERENCES users(id), status TEXT, agent_id TEXT,
      registration_id TEXT, run_id INTEGER, blocks_json TEXT, harness_log TEXT, images_json TEXT,
      attachments_json TEXT, reply_to_json TEXT, forwarded_from_json TEXT, change_request_json TEXT,
      mission_json TEXT, mission_task_id TEXT, clarification_json TEXT
    );
    INSERT INTO chat_messages_next(
      rowid,id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,
      registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,reply_to_json,
      forwarded_from_json,change_request_json,mission_json,mission_task_id,clarification_json
    ) SELECT
      rowid,id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,
      registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,reply_to_json,
      forwarded_from_json,change_request_json,mission_json,${missionTaskExpression},clarification_json
    FROM chat_messages;
    DROP TABLE chat_messages;
    ALTER TABLE chat_messages_next RENAME TO chat_messages;
    PRAGMA foreign_keys=ON;
  `);
  db.close();
}

function runOwnershipFixture() {
  const files = fixture();
  const before = new Database(files.before);
  before.exec(`
    INSERT INTO users VALUES (2, 'other');
    CREATE TABLE vaults (id TEXT PRIMARY KEY);
    INSERT INTO vaults VALUES ('vault-1'), ('vault-2');
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT,
      conversation_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      summary TEXT,
      model TEXT
    );
    ALTER TABLE runs ADD COLUMN chat_dispatch_id TEXT;
    CREATE UNIQUE INDEX runs_chat_dispatch_idx
      ON runs(chat_dispatch_id) WHERE chat_dispatch_id IS NOT NULL;
    CREATE TABLE delegated_runs (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO runs(id,vault_id,prompt,status) VALUES
      (10,'vault-1','owned active','running'),
      (11,'vault-2','legacy terminal','completed'),
      (12,'vault-1','other active','queued');
    INSERT INTO delegated_runs(run_id,owner_user_id) VALUES (10,1),(12,2);
  `);
  before.close();
  fs.copyFileSync(files.before, files.after);
  return files;
}

function migrateRunOwnership(filename) {
  const db = new Database(filename);
  db.exec(`
    ALTER TABLE runs ADD COLUMN owner_user_id INTEGER REFERENCES users(id);
    UPDATE runs
    SET owner_user_id=(SELECT d.owner_user_id FROM delegated_runs d WHERE d.run_id=runs.id)
    WHERE owner_user_id IS NULL
      AND EXISTS (SELECT 1 FROM delegated_runs d WHERE d.run_id=runs.id);
    CREATE INDEX runs_owner_active_idx
      ON runs(owner_user_id,status,started_at DESC,id DESC);
  `);
  db.close();
}

test('accepts only the pinned schema normalization while preserving rows and rowids', () => {
  const files = normalizationFixture();
  try {
    normalizeVaultMembers(files.after);
    const result = runComparison(files);
    assert.equal(result.ok, true, result.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects a normalized table that compacts historical rowids', () => {
  const files = normalizationFixture();
  try {
    normalizeVaultMembers(files.after, false);
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith(
      'table changed outside pinned normalization: vault_members',
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('accepts only the deterministic Node mission-task repair during chat normalization', () => {
  const files = chatBackfillFixture();
  try {
    normalizeChatMessages(
      files.after,
      "COALESCE(mission_task_id,(SELECT id FROM chat_mission_tasks WHERE run_id=chat_messages.run_id ORDER BY rowid LIMIT 1))",
    );
    const result = runComparison(files);
    assert.equal(result.ok, true, result.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects an unrelated mission-task mutation hidden in chat normalization', () => {
  const files = chatBackfillFixture();
  try {
    normalizeChatMessages(files.after, "'not-the-linked-task'");
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith(
      'table changed outside pinned normalization: chat_messages',
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('accepts only the exact run-owner schema and delegated-owner backfill', () => {
  const files = runOwnershipFixture();
  try {
    migrateRunOwnership(files.after);
    const result = runComparison(files);
    assert.equal(result.ok, true, result.failures.join('\n'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects a foreign owner hidden in the run ownership migration', () => {
  const files = runOwnershipFixture();
  try {
    migrateRunOwnership(files.after);
    const after = new Database(files.after);
    after.prepare('UPDATE runs SET owner_user_id=? WHERE id=?').run(2, 10);
    after.close();
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith(
      'table changed outside pinned ownership migration: runs',
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('runs the FTS5 external-content integrity check instead of trusting projected rows', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec(`
      CREATE VIRTUAL TABLE notes_search_fts USING fts5(body,content='notes',content_rowid='rowid');
      CREATE TRIGGER notes_search_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_search_fts(rowid,body) VALUES(NEW.rowid,NEW.body);
      END;
      INSERT INTO notes_search_fts(notes_search_fts) VALUES('rebuild');
    `);
    before.close();
    fs.copyFileSync(files.before, files.after);
    assert.equal(runComparison(files).ok, true);

    const after = new Database(files.after);
    after.exec("INSERT INTO notes_search_fts(notes_search_fts) VALUES('delete-all')");
    after.close();
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith(
      'FTS integrity check failed for notes_search_fts',
    )));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects arbitrary tables that merely resemble FTS5 shadow tables', () => {
  const added = fixture();
  try {
    const db = new Database(added.after);
    db.exec('CREATE TABLE evil_fts_data (value TEXT)');
    db.close();
    const result = runComparison(added);
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('unexpected table added: evil_fts_data'));
  } finally {
    fs.rmSync(added.directory, { recursive: true, force: true });
  }

  const removed = fixture();
  try {
    const before = new Database(removed.before);
    before.exec('CREATE TABLE evil_fts_data (value TEXT)');
    before.close();
    fs.copyFileSync(removed.before, removed.after);
    const after = new Database(removed.after);
    after.exec('DROP TABLE evil_fts_data');
    after.close();
    const result = runComparison(removed);
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('table removed: evil_fts_data'));
  } finally {
    fs.rmSync(removed.directory, { recursive: true, force: true });
  }
});

test('fails on row, schema, integrity, or vault-file drift', () => {
  const files = fixture();
  try {
    const db = new Database(files.after);
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run('changed', 'note-1');
    db.close();
    fs.writeFileSync(path.join(files.afterRoot, 'General.md'), '# Changed\n');
    const result = runComparison(files);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.startsWith('table changed: notes')));
    assert.ok(result.failures.includes('vault file tree changed'));
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('child migration preserves existing tasks and starts with empty ownership and join state', () => {
  const files = fixture();
  try {
    const before = new Database(files.before);
    before.exec("CREATE TABLE chat_mission_tasks(id TEXT PRIMARY KEY,run_id INTEGER,status TEXT); INSERT INTO chat_mission_tasks VALUES('parent',9,'running')");
    before.close();
    fs.copyFileSync(files.before, files.after);
    const after = new Database(files.after);
    after.exec('ALTER TABLE chat_mission_tasks ADD COLUMN parent_task_id TEXT');
    after.exec('ALTER TABLE chat_mission_tasks ADD COLUMN child_result_delivered INTEGER NOT NULL DEFAULT 0');
    after.exec('ALTER TABLE chat_mission_tasks ADD COLUMN joining_children INTEGER NOT NULL DEFAULT 0');
    after.exec('CREATE INDEX chat_mission_tasks_parent_idx ON chat_mission_tasks(parent_task_id)');
    after.close();
    assert.equal(runComparison(files).ok, true, runComparison(files).failures.join('\n'));
    for (const [column, value] of [['parent_task_id', 'invented'], ['joining_children', 1], ['child_result_delivered', 1], ['status', 'completed']]) {
      const changed = new Database(files.after);
      const original = changed.prepare(`SELECT ${column} AS value FROM chat_mission_tasks`).get().value;
      changed.prepare(`UPDATE chat_mission_tasks SET ${column}=?`).run(value);
      changed.close();
      assert.equal(runComparison(files).ok, false, column);
      const restore = new Database(files.after);
      restore.prepare(`UPDATE chat_mission_tasks SET ${column}=?`).run(original);
      restore.close();
    }
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('schema fingerprint sees committed WAL DDL without allocating a database copy', () => {
  const files = fixture();
  const writer = new Database(files.before);
  const previousScratch = process.env.CASCADE_SQLITE_SNAPSHOT_TMPDIR;
  try {
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec(`CREATE TABLE wal_schema (id INTEGER PRIMARY KEY);
      CREATE TABLE cascade_elixir_schema_migrations (version INTEGER, name TEXT, checksum TEXT);
      INSERT INTO cascade_elixir_schema_migrations VALUES (42, 'wal_migration', 'checksum');`);
    assert.ok(fs.statSync(`${files.before}-wal`).size > 0);
    // A full-copy implementation cannot succeed with no usable scratch path.
    process.env.CASCADE_SQLITE_SNAPSHOT_TMPDIR = files.before;
    const fingerprint = readSchemaFingerprint(files.before);
    assert.ok(fingerprint.objects.some(object => object.name === 'wal_schema'));
    assert.deepEqual(fingerprint.migrations, [{ version: 42, name: 'wal_migration', checksum: 'checksum' }]);
    assert.equal(writer.prepare('SELECT COUNT(*) FROM notes').pluck().get(), 1);
  } finally {
    if (previousScratch === undefined) delete process.env.CASCADE_SQLITE_SNAPSHOT_TMPDIR;
    else process.env.CASCADE_SQLITE_SNAPSHOT_TMPDIR = previousScratch;
    writer.close();
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

for (const table of ['chat_mission_interpretations', 'chat_coordinator_continuations']) {
  test(`${table} migration permits only its reviewed empty schema`, () => {
    const files = fixture();
    try {
      const schema = fs.readFileSync(new URL('../backend_elixir/lib/cascade/missions/schema.ex', import.meta.url), 'utf8');
      const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\)`))[0];
      const after = new Database(files.after);
      after.exec(ddl);
      if (table === 'chat_mission_interpretations') {
        after.exec(schema.match(/CREATE UNIQUE INDEX IF NOT EXISTS chat_mission_interpretations_dispatch_idx[^"\n]+/)[0]);
      }
      after.close();
      assert.equal(runComparison(files).ok, true, runComparison(files).failures.join('\n'));
      const malformed = new Database(files.after);
      malformed.exec(`ALTER TABLE ${table} ADD COLUMN unreviewed TEXT`);
      malformed.close();
      assert.equal(runComparison(files).ok, false);
    } finally {
      fs.rmSync(files.directory, { recursive: true, force: true });
    }
  });
}
