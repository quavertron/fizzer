#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

const DEFAULT_ALLOWED_ADDITIONS = new Set(['cascade_elixir_schema_migrations']);
const EMPTY_TABLE_ADDITIONS = new Map([
  ['chat_mission_recovery_evidence', '8039530f643ab926e1306c88d074dc731b6b5c248cd032ac3d591bbaf2ee185b'],
  ['chat_next_step_checks', '975a576a29b23ab328602d5f3a7a888cc1f3624e89242bcb44f38ae0654fd6e5'],
]);
const FTS5_SHADOW_SUFFIXES = ['config', 'data', 'docsize', 'idx'];
const DISPATCH_ADMISSION_COLUMNS = [
  ['requester_user_id', 'INTEGER REFERENCES users(id)'],
  ['requester_channel_id', 'TEXT'],
  ['target_owner_user_id', 'INTEGER REFERENCES users(id)'],
  ['target_identity_id', 'TEXT'],
  ['conversation_id', 'TEXT'],
  ['error', 'TEXT'],
  ['failed_at', 'TEXT'],
];

// These hashes pin the intentional one-time normalization performed by the
// Elixir bootstrap. A table is not accepted merely because its rows happen to
// compare equal: the resulting schema must be the reviewed Node-compatible
// shape as well.
const NORMALIZED_TABLE_SQL_SHA256 = new Map([
  ['chat_agent_members', 'cbad10329484a7a611ef7c9c5789bc88987431279e0fdd44d51817579d693676'],
  ['chat_channel_links', '5c044d64e74a55bae505e0dc14fa0943d8f2ec550a3a4ee0c8cee6098b8b2f51'],
  ['chat_messages', 'c0ec7be003cb9470e0854022dd4197394b8b52e5b6d81369ab274151ccaf7ae4'],
  ['chat_messages_fts', 'a0537f09f6a0d235e2c50e090ce48214ddd0efa80544131812ccd37822e501a1'],
  ['vault_members', '90145e23f3aae530384ffca13a728c3caef47d31297078bc9cb09e78a520c6ca'],
]);

const NORMALIZED_OBJECT_SQL_SHA256 = new Map([
  ['index:chat_mission_tasks_parent_idx', '7f97ee4f014dd90c75c5256385a9fb24806dfb35328915cf9d17b4c06eff4c47'],
  ['index:chat_messages_activity_idx', '57b71e5d8f446140a9ea1a97fdd9b06bf02943fc0c09c38e2a7208ba49dc9fd1'],
  ['index:chat_messages_channel_idx', 'cf59031cf62c9ad6b72e763f899a42bc683db9547811618c25b71720948f4bf2'],
  ['trigger:chat_messages_ai', 'fe4b388168890405a812c0baa7c785d19637612a642546e67820ecb975c9ce0e'],
  ['trigger:chat_messages_ad', 'd5ca273ea2357f3e4868b3595e75ea29d152cb4d41081f1a25a04abe19f3f60e'],
  ['trigger:chat_messages_au', '839d6582356d56eb5ae5b8391e078d3922762de41e5d77f09c678a70496143e1'],
  ['index:chat_mission_events_source_key_idx', '2c8b0abee1bdda9732d0801bfb1370a05c349190a1d6d7b1a75bb1ec2b564767'],
  ['index:runs_owner_active_idx', '2f1bd1bf23ba264283a4b5097177e08c9f5e37defd10b936faa4bdff93fc3ea9'],
  ['index:chat_agent_members_identity_idx', '1744cce7ccd24c24973e1e44fc9a00cdcb3f20545cc643e3ec4cb10d02f0a52d'],
]);

const MIGRATION_LEDGER_SQL_SHA256 =
  '8bff981d0086d2f5b51a359df3ef99a46c398c202a15f151906c67c50e539cdd';
const MIGRATION_LEDGER_ROW = {
  version: 1,
  name: 'core_node_schema_compatibility',
  checksum: 'b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a',
};

// Reviewed schema transitions that are safe while the previous release is
// still serving. Keep these exact and directional: an unrecognized DDL change
// must continue through the snapshot-backed maintenance cutover.
const ROLLING_SCHEMA_TRANSITIONS = new Map([
  ['table:chat_agent_members', new Map([
    ['caa0376559c9e2b1327b414bea0b8c92c110f093b2d83277ffbc0778367cd59c',
      '47958f4df6d7c4133c1a4d0841d2f061a18aa79f9d62bf861b1d423eb18ef7a1'],
    ['47958f4df6d7c4133c1a4d0841d2f061a18aa79f9d62bf861b1d423eb18ef7a1',
      '30fe78099a2ac07b54f147ed25e4032966f9b0a1187852e5a5aece9cca765b43'],
    ['30fe78099a2ac07b54f147ed25e4032966f9b0a1187852e5a5aece9cca765b43',
      'cbad10329484a7a611ef7c9c5789bc88987431279e0fdd44d51817579d693676'],
  ])],
]);

function parseArgs(argv) {
  const args = { allowTable: [], requireIdentical: false, schemaOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'require-identical') {
      args.requireIdentical = true;
      continue;
    }
    if (key === 'schema-only') {
      args.schemaOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    index += 1;
    if (key === 'allow-table') args.allowTable.push(value);
    else if (key === 'before') args.before = value;
    else if (key === 'after') args.after = value;
    else if (key === 'before-root') args.beforeRoot = value;
    else if (key === 'after-root') args.afterRoot = value;
    else if (key === 'before-schema') args.beforeSchema = value;
    else if (key === 'after-schema') args.afterSchema = value;
    else if (key === 'dump-schema') args.dumpSchema = value;
    else if (key === 'materialize-schema') args.materializeSchema = value;
    else if (key === 'materialize-dest') args.materializeDest = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  if (args.dumpSchema || args.materializeSchema) {
    if (args.dumpSchema && (args.before || args.after || args.materializeSchema)) {
      throw new Error('--dump-schema cannot be combined with comparison or materialize options');
    }
    if (args.materializeSchema && !args.materializeDest) {
      throw new Error('--materialize-schema requires --materialize-dest');
    }
    return args;
  }
  args.before = args.beforeSchema || args.before;
  args.after = args.afterSchema || args.after;
  if (!args.before || !args.after) {
    throw new Error('provide --before/--after or --before-schema/--after-schema');
  }
  if (Boolean(args.beforeRoot) !== Boolean(args.afterRoot)) {
    throw new Error('--before-root and --after-root must be supplied together');
  }
  if (args.requireIdentical && args.schemaOnly) {
    throw new Error('--require-identical and --schema-only are mutually exclusive');
  }
  if ((args.beforeSchema || args.afterSchema) && !args.schemaOnly) args.schemaOnly = true;
  return args;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function normalizedSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodeValue(value) {
  if (Buffer.isBuffer(value)) return { $blob: value.toString('base64') };
  if (typeof value === 'bigint') return { $integer: value.toString() };
  return value;
}

function hashRows(db, table, sql) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  const valueColumns = [...columns].sort((left, right) => left.name.localeCompare(right.name));
  const primaryKey = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => quoteIdentifier(column.name));
  const virtual = /^CREATE VIRTUAL TABLE\b/i.test(String(sql || ''));
  const withoutRowid = /\bWITHOUT ROWID\b/i.test(String(sql || ''));
  const ordering = primaryKey.length
    ? primaryKey.join(', ')
    : withoutRowid
      ? columns.map((column) => quoteIdentifier(column.name)).join(', ')
      : 'rowid';
  const includesRowid = !withoutRowid;
  const selection = [
    ...(includesRowid ? ['rowid AS "__cascade_rowid"'] : []),
    ...valueColumns.map((column) => quoteIdentifier(column.name)),
  ].join(', ');
  const statement = db.prepare(`SELECT ${selection} FROM ${quoteIdentifier(table)}${ordering ? ` ORDER BY ${ordering}` : ''}`);
  const hash = crypto.createHash('sha256');
  const columnHashes = new Map(valueColumns.map((column) => [column.name, crypto.createHash('sha256')]));
  let count = 0;
  for (const row of statement.iterate()) {
    const values = [
      ...(includesRowid ? [encodeValue(row.__cascade_rowid)] : []),
      ...valueColumns.map((column) => encodeValue(row[column.name])),
    ];
    hash.update(JSON.stringify(values));
    hash.update('\n');
    for (const column of valueColumns) {
      const digest = columnHashes.get(column.name);
      if (includesRowid) {
        digest.update(JSON.stringify(encodeValue(row.__cascade_rowid)));
        digest.update('\0');
      }
      digest.update(JSON.stringify(encodeValue(row[column.name])));
      digest.update('\n');
    }
    count += 1;
  }
  return {
    count,
    sha256: hash.digest('hex'),
    virtual,
    includesRowid,
    columns: valueColumns.map((column) => column.name),
    columnSha256: Object.fromEntries(
      [...columnHashes.entries()].map(([name, digest]) => [name, digest.digest('hex')]),
    ),
  };
}

function normalizedForeignKeys(rows) {
  return rows.map((row) => ({
    table: row.table,
    from: row.from,
    to: row.to,
    onUpdate: row.on_update,
    onDelete: row.on_delete,
    match: row.match,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function databaseScratchDirectory(prefix) {
  const configured = process.env.CASCADE_SQLITE_SNAPSHOT_TMPDIR || os.tmpdir();
  const root = fs.realpathSync(path.resolve(configured));
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`SQLite snapshot scratch is not a directory: ${root}`);
  return fs.mkdtempSync(path.join(root, prefix));
}

function databaseSnapshotFromCopy(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = db.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error(`${filename}: PRAGMA quick_check returned ${quickCheck}`);
    const foreignKeys = db.pragma('foreign_key_check');
    if (foreignKeys.length) {
      throw new Error(`${filename}: ${foreignKeys.length} foreign-key violation(s)`);
    }
    const objects = db.prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const schema = Object.fromEntries(objects.map((object) => [
      `${object.type}:${object.name}`,
      {
        type: object.type,
        name: object.name,
        tableName: object.tableName,
        sql: normalizedSql(object.sql),
        sqlSha256: sha256(normalizedSql(object.sql)),
      },
    ]));
    const tables = {};
    for (const object of objects) {
      if (object.type !== 'table') continue;
      tables[object.name] = {
        schema: schema[`table:${object.name}`],
        columns: db.prepare(`PRAGMA table_info(${quoteIdentifier(object.name)})`).all(),
        foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(object.name)})`).all(),
        normalizedForeignKeys: normalizedForeignKeys(
          db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(object.name)})`).all(),
        ),
        rows: hashRows(db, object.name, object.sql),
        ...(object.name === 'cascade_elixir_schema_migrations'
          ? { migrationRows: db.prepare('SELECT version,name,checksum,applied_at FROM cascade_elixir_schema_migrations ORDER BY version').all() }
          : {}),
      };
    }
    const compatibility = {};
    if (tables.chat_messages) {
      compatibility.chatMessageTaskLinks = db.prepare(`
        SELECT id,run_id AS runId,mission_task_id AS missionTaskId
        FROM chat_messages ORDER BY id
      `).all();
    }
    if (tables.chat_missions && ['authority_json', 'verification', 'review_attempt'].every(
      (name) => tables.chat_missions.columns.some((column) => column.name === name),
    )) {
      compatibility.missionRecoveryNonDefaults = db.prepare(`
        SELECT COUNT(*) AS count FROM chat_missions
        WHERE authority_json <> '[]' OR verification <> '' OR review_attempt <> 0
      `).get().count;
    }
    if (tables.chat_missions?.columns.some((column) => column.name === 'review_fingerprint')) {
      compatibility.missionFingerprintNonDefaults = db.prepare(
        "SELECT COUNT(*) AS count FROM chat_missions WHERE review_fingerprint <> ''",
      ).get().count;
    }
    if (tables.chat_mission_tasks?.columns.some((column) => column.name === 'joining_children')) {
      compatibility.missionChildNonDefaults = db.prepare(
        'SELECT COUNT(*) AS count FROM chat_mission_tasks WHERE parent_task_id IS NOT NULL OR child_result_delivered <> 0 OR joining_children <> 0',
      ).get().count;
    }
    if (tables.chat_mission_tasks) {
      const hasWorkspaceMode = tables.chat_mission_tasks.columns
        .some((column) => column.name === 'workspace_mode');
      compatibility.missionTaskRuns = db.prepare(`
        SELECT id,run_id AS runId FROM chat_mission_tasks
        WHERE run_id IS NOT NULL ORDER BY rowid
      `).all();
      compatibility.missionTaskWorkspaces = db.prepare(`
        SELECT rowid,id,${hasWorkspaceMode ? 'workspace_mode' : "'shared'"} AS workspaceMode
        FROM chat_mission_tasks ORDER BY rowid
      `).all();
    }
    if (tables.chat_agent_dispatches) {
      const added = DISPATCH_ADMISSION_COLUMNS.filter(([name]) => (
        tables.chat_agent_dispatches.columns.some((column) => column.name === name)
      ));
      if (added.length) {
        compatibility.dispatchAdmissionNonNullRows = db.prepare(`
          SELECT COUNT(*) AS count FROM chat_agent_dispatches
          WHERE ${added.map(([name]) => `${quoteIdentifier(name)} IS NOT NULL`).join(' OR ')}
        `).get().count;
      }
    }
    if (tables.runs) {
      const hasOwner = tables.runs.columns.some((column) => column.name === 'owner_user_id');
      compatibility.runOwnership = db.prepare(`
        SELECT rowid,id,${hasOwner ? 'owner_user_id' : 'NULL'} AS ownerUserId
        FROM runs ORDER BY rowid
      `).all();
    }
    if (tables.vault_agents) {
      const hasHermesProfile = tables.vault_agents.columns.some((column) => column.name === 'hermes_profile');
      const hasHermesSafeMode = tables.vault_agents.columns.some((column) => column.name === 'hermes_safe_mode');
      const hasIdentityScope = tables.vault_agents.columns.some((column) => column.name === 'identity_scope');
      const hasExpiresAt = tables.vault_agents.columns.some((column) => column.name === 'expires_at');
      compatibility.vaultAgentHermes = db.prepare(`
        SELECT rowid,id,
          ${hasHermesProfile ? 'hermes_profile' : "''"} AS hermesProfile,
          ${hasHermesSafeMode ? 'hermes_safe_mode' : '0'} AS hermesSafeMode,
          ${hasIdentityScope ? 'identity_scope' : "'network'"} AS identityScope,
          ${hasExpiresAt ? 'expires_at' : 'NULL'} AS expiresAt
        FROM vault_agents ORDER BY rowid
      `).all();
    }
    if (tables.delegated_runs) {
      if (['delivery_payload_json', 'delivery_sent_at', 'delivery_attempts'].every(name => (
        tables.delegated_runs.columns.some(column => column.name === name)
      ))) {
        compatibility.deliveryNonDefaults = db.prepare(`
          SELECT COUNT(*) AS count FROM delegated_runs WHERE delivery_payload_json IS NOT NULL
            OR delivery_sent_at IS NOT NULL OR delivery_attempts IS NOT 0
        `).get().count;
      }
      compatibility.delegatedRunOwners = db.prepare(`
        SELECT run_id AS runId,owner_user_id AS ownerUserId
        FROM delegated_runs ORDER BY run_id
      `).all();
    }
    return { quickCheck, schema, tables, compatibility };
  } finally {
    db.close();
  }
}

export function databaseSnapshot(filename) {
  const directory = databaseScratchDirectory('cascade-database-snapshot-');
  const disposable = path.join(directory, 'database.sqlite');
  try {
    fs.copyFileSync(path.resolve(filename), disposable, fs.constants.COPYFILE_FICLONE);
    return databaseSnapshotFromCopy(disposable);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const SCHEMA_OBJECT_ORDER = { table: 0, index: 1, trigger: 2, view: 3 };

function fts5ShadowNames(objects) {
  const virtual = objects
    .filter((object) => /\bUSING\s+fts5\s*\(/iu.test(object.sql || ''))
    .map((object) => object.name);
  const shadows = new Set();
  for (const table of virtual) {
    for (const suffix of [...FTS5_SHADOW_SUFFIXES, 'content']) shadows.add(`${table}_${suffix}`);
    for (const object of objects) {
      if (object.name.startsWith(`${table}_`)) shadows.add(object.name);
    }
  }
  return shadows;
}

export function readSchemaFingerprintFromDb(db) {
  const objects = db.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map((object) => ({
    type: object.type,
    name: object.name,
    tableName: object.tableName,
    sql: normalizedSql(object.sql),
  }));
  const shadows = fts5ShadowNames(objects);
  const visible = objects.filter((object) => !shadows.has(object.name));
  let migrations = [];
  const hasLedger = visible.some((object) => object.type === 'table' && object.name === 'cascade_elixir_schema_migrations');
  if (hasLedger) {
    migrations = db.prepare(
      'SELECT version, name, checksum FROM cascade_elixir_schema_migrations ORDER BY version',
    ).all();
  }
  return { objects: visible, migrations };
}

export function readSchemaFingerprint(filename) {
  const directory = databaseScratchDirectory('cascade-schema-fingerprint-');
  const disposable = path.join(directory, 'database.sqlite');
  try {
    fs.copyFileSync(path.resolve(filename), disposable, fs.constants.COPYFILE_FICLONE);
    const db = new Database(disposable, { readonly: true, fileMustExist: true });
    try {
      return readSchemaFingerprintFromDb(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function loadSchemaFingerprint(source) {
  if (source && typeof source === 'object' && !Array.isArray(source)) return source;
  const text = fs.readFileSync(source, 'utf8');
  if (text.startsWith('{')) return JSON.parse(text);
  return readSchemaFingerprint(source);
}

export function compareSchemaFingerprints(before, after) {
  const failures = [];
  const beforeObjects = new Map(before.objects.map((object) => [`${object.type}:${object.name}`, object]));
  const afterObjects = new Map(after.objects.map((object) => [`${object.type}:${object.name}`, object]));
  let objectsMatch = beforeObjects.size === afterObjects.size;
  if (objectsMatch) {
    for (const [key, oldObject] of beforeObjects) {
      const nextObject = afterObjects.get(key);
      if (!nextObject) {
        objectsMatch = false;
        break;
      }
      if (same(oldObject, nextObject)) continue;
      const transitions = ROLLING_SCHEMA_TRANSITIONS.get(key);
      const oldHash = sha256(normalizedSql(oldObject.sql));
      const nextHash = sha256(normalizedSql(nextObject.sql));
      if (oldObject.type !== nextObject.type
          || oldObject.name !== nextObject.name
          || oldObject.tableName !== nextObject.tableName
          || transitions?.get(oldHash) !== nextHash) {
        objectsMatch = false;
        break;
      }
    }
  }
  if (!objectsMatch) failures.push('database schema changed');
  if (!same(before.migrations, after.migrations)) failures.push('migration ledger changed');
  return failures;
}

export function materializeSchemaFingerprint(fingerprint, destination) {
  if (fs.existsSync(destination)) fs.rmSync(destination);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${destination}${suffix}`); } catch { /* fresh dest */ }
  }
  const db = new Database(destination);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const objects = [...(fingerprint.objects || [])].sort((left, right) => {
      const order = (SCHEMA_OBJECT_ORDER[left.type] ?? 9) - (SCHEMA_OBJECT_ORDER[right.type] ?? 9);
      return order || left.name.localeCompare(right.name);
    });
    const shadows = fts5ShadowNames(objects);
    for (const object of objects) {
      if (shadows.has(object.name)) continue;
      if (!object.sql) continue;
      try {
        db.exec(object.sql);
      } catch (error) {
        if (!/already exists/i.test(error.message)) throw error;
      }
    }
    if (fingerprint.migrations?.length) {
      const insert = db.prepare(
        'INSERT INTO cascade_elixir_schema_migrations(version, name, checksum) VALUES (?, ?, ?)',
      );
      for (const row of fingerprint.migrations) insert.run(row.version, row.name, row.checksum);
    }
  } finally {
    db.close();
  }
}

function exactRowsOrMissionTaskBackfill(table, before, after) {
  if (same(before.tables[table].rows, after.tables[table].rows)) return true;
  if (table !== 'chat_messages') return false;
  const oldRows = before.tables[table].rows;
  const newRows = after.tables[table].rows;
  if (oldRows.count !== newRows.count
      || oldRows.includesRowid !== newRows.includesRowid
      || !same(oldRows.columns, newRows.columns)) return false;
  for (const column of oldRows.columns) {
    if (column !== 'mission_task_id'
        && oldRows.columnSha256[column] !== newRows.columnSha256[column]) return false;
  }

  const beforeLinks = before.compatibility.chatMessageTaskLinks || [];
  const afterLinks = after.compatibility.chatMessageTaskLinks || [];
  if (beforeLinks.length !== afterLinks.length) return false;
  const firstTaskByRun = new Map();
  for (const task of after.compatibility.missionTaskRuns || []) {
    if (!firstTaskByRun.has(task.runId)) firstTaskByRun.set(task.runId, task.id);
  }
  for (let index = 0; index < beforeLinks.length; index += 1) {
    const oldLink = beforeLinks[index];
    const newLink = afterLinks[index];
    if (oldLink.id !== newLink.id || oldLink.runId !== newLink.runId) return false;
    const expected = oldLink.missionTaskId
      ?? (oldLink.runId == null ? null : firstTaskByRun.get(oldLink.runId) ?? null);
    if (newLink.missionTaskId !== expected) return false;
  }
  return true;
}

function exactDefaultColumnMigration(before, after, table, additions, nonDefaults) {
  const oldTable = before.tables[table];
  const newTable = after.tables[table];
  if (oldTable.columns.some(column => additions.some(({ name }) => column.name === name))) return false;
  if (!same(newTable.columns.slice(oldTable.columns.length).map(({ name, type, notnull, dflt_value, pk }) => (
    { name, type, notnull, dflt_value, pk }
  )), additions)) return false;
  const suffix = additions.map(({ name, type, notnull, dflt_value }) => (
    `, ${name} ${type}${notnull ? ' NOT NULL' : ''}${dflt_value == null ? '' : ` DEFAULT ${dflt_value}`}`
  )).join('');
  // SQLite inserts added columns before trailing table constraints.
  return newTable.schema.sql.replace(suffix, '') === oldTable.schema.sql
    && same(oldTable.columns, newTable.columns.slice(0, oldTable.columns.length))
    && same(oldTable.normalizedForeignKeys, newTable.normalizedForeignKeys)
    && oldTable.rows.count === newTable.rows.count
    && oldTable.rows.includesRowid === newTable.rows.includesRowid
    && oldTable.rows.columns.every(column => oldTable.rows.columnSha256[column] === newTable.rows.columnSha256[column])
    && after.compatibility[nonDefaults] === 0;
}

function exactMissionRecoveryMigration(before, after, fingerprintOnly = false) {
  return exactDefaultColumnMigration(before, after, 'chat_missions', fingerprintOnly ? [
    { name: 'review_fingerprint', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
  ] : [
    { name: 'authority_json', type: 'TEXT', notnull: 1, dflt_value: "'[]'", pk: 0 },
    { name: 'verification', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
    { name: 'review_attempt', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
  ], fingerprintOnly ? 'missionFingerprintNonDefaults' : 'missionRecoveryNonDefaults');
}

function exactMissionChildMigration(before, after) {
  return exactDefaultColumnMigration(before, after, 'chat_mission_tasks', [
    { name: 'parent_task_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'child_result_delivered', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'joining_children', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
  ], 'missionChildNonDefaults');
}

function exactDeliveryMigration(before, after) {
  return exactDefaultColumnMigration(before, after, 'delegated_runs', [
    { name: 'delivery_payload_json', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'delivery_sent_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'delivery_attempts', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
  ], 'deliveryNonDefaults');
}

function exactMissionWorkspaceModeMigration(before, after) {
  const oldTable = before.tables.chat_mission_tasks;
  const newTable = after.tables.chat_mission_tasks;
  const oldColumnNames = oldTable.columns.map((column) => column.name);
  const newColumnNames = newTable.columns.map((column) => column.name);
  const workspace = newTable.columns.find((column) => column.name === 'workspace_mode');
  if (oldColumnNames.includes('workspace_mode')
      || !workspace
      || workspace.type !== 'TEXT'
      || Number(workspace.notnull) !== 1
      || workspace.dflt_value !== "'shared'"
      || Number(workspace.pk) !== 0
      || !same(newColumnNames, [...oldColumnNames, 'workspace_mode'])
      || !same(oldTable.normalizedForeignKeys, newTable.normalizedForeignKeys)) return false;

  const expectedSql = oldTable.schema.sql.replace(
    /\)$/u,
    ", workspace_mode TEXT NOT NULL DEFAULT 'shared')",
  );
  if (newTable.schema.sql !== expectedSql) return false;

  const oldRows = oldTable.rows;
  const newRows = newTable.rows;
  if (oldRows.count !== newRows.count || oldRows.includesRowid !== newRows.includesRowid) return false;
  for (const column of oldRows.columns) {
    if (oldRows.columnSha256[column] !== newRows.columnSha256[column]) return false;
  }
  const workspaces = after.compatibility.missionTaskWorkspaces || [];
  return workspaces.length === newRows.count
    && workspaces.every((row) => row.workspaceMode === 'shared');
}

function exactDispatchAdmissionMigration(before, after) {
  const oldTable = before.tables.chat_agent_dispatches;
  const newTable = after.tables.chat_agent_dispatches;
  const additions = DISPATCH_ADMISSION_COLUMNS.map(([name, definition], index) => ({
    cid: oldTable.columns.length + index,
    name,
    type: definition.split(' ')[0],
    notnull: 0,
    dflt_value: null,
    pk: 0,
  }));
  if (additions.some(({ name }) => oldTable.columns.some((column) => column.name === name))
      || !same(newTable.columns, [...oldTable.columns, ...additions])) return false;

  const expectedForeignKeys = [
    ...oldTable.normalizedForeignKeys,
    ...['requester_user_id', 'target_owner_user_id'].map((from) => ({
      table: 'users', from, to: 'id', onUpdate: 'NO ACTION', onDelete: 'NO ACTION', match: 'NONE',
    })),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  // SQLite inserts added columns before the trailing table constraint.
  const expectedSql = oldTable.schema.sql.replace(
    /, UNIQUE\(message_id, registration_id\) \)$/u,
    `, ${DISPATCH_ADMISSION_COLUMNS.map(([name, definition]) => `${name} ${definition}`).join(', ')}, UNIQUE(message_id, registration_id) )`,
  );
  return newTable.schema.sql === expectedSql
    && same(newTable.normalizedForeignKeys, expectedForeignKeys)
    && oldTable.rows.count === newTable.rows.count
    && oldTable.rows.includesRowid === newTable.rows.includesRowid
    && oldTable.rows.columns.every((column) => (
      oldTable.rows.columnSha256[column] === newTable.rows.columnSha256[column]
    ))
    && after.compatibility.dispatchAdmissionNonNullRows === 0;
}

function exactRunOwnershipSchema(before, after) {
  const oldTable = before.tables.runs;
  const newTable = after.tables.runs;
  if (!oldTable || !newTable) return false;

  const oldOwner = oldTable.columns.find((column) => column.name === 'owner_user_id');
  const newOwner = newTable.columns.find((column) => column.name === 'owner_user_id');
  if (!newOwner
      || newOwner.type !== 'INTEGER'
      || Number(newOwner.notnull) !== 0
      || newOwner.dflt_value !== null
      || Number(newOwner.pk) !== 0) return false;

  if (oldOwner) {
    return same(oldTable.schema, newTable.schema)
      && same(oldTable.columns, newTable.columns)
      && same(oldTable.normalizedForeignKeys, newTable.normalizedForeignKeys);
  }

  const expectedColumns = [
    ...oldTable.columns,
    { ...newOwner, cid: oldTable.columns.length },
  ];
  const expectedForeignKeys = [
    ...oldTable.normalizedForeignKeys,
    {
      table: 'users',
      from: 'owner_user_id',
      to: 'id',
      onUpdate: 'NO ACTION',
      onDelete: 'NO ACTION',
      match: 'NONE',
    },
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const expectedSql = oldTable.schema.sql.replace(
    /\)\s*$/u,
    ', owner_user_id INTEGER REFERENCES users(id))',
  );
  return same(expectedColumns, newTable.columns)
    && same(expectedForeignKeys, newTable.normalizedForeignKeys)
    && newTable.schema.sql === expectedSql;
}

function exactRunOwnershipBackfill(before, after) {
  if (!exactRunOwnershipSchema(before, after)) return false;
  const oldRows = before.tables.runs.rows;
  const newRows = after.tables.runs.rows;
  const oldColumns = oldRows.columns.filter((column) => column !== 'owner_user_id');
  if (oldRows.count !== newRows.count
      || oldRows.includesRowid !== newRows.includesRowid
      || !oldColumns.every((column) => newRows.columns.includes(column))) return false;
  for (const column of oldColumns) {
    if (oldRows.columnSha256[column] !== newRows.columnSha256[column]) return false;
  }

  const oldOwnership = before.compatibility.runOwnership || [];
  const newOwnership = after.compatibility.runOwnership || [];
  if (oldOwnership.length !== newOwnership.length) return false;
  const delegated = new Map(
    (before.compatibility.delegatedRunOwners || [])
      .map((row) => [row.runId, row.ownerUserId]),
  );
  for (let index = 0; index < oldOwnership.length; index += 1) {
    const oldRun = oldOwnership[index];
    const newRun = newOwnership[index];
    if (oldRun.rowid !== newRun.rowid || oldRun.id !== newRun.id) return false;
    const expectedOwner = oldRun.ownerUserId ?? delegated.get(oldRun.id) ?? null;
    if (newRun.ownerUserId !== expectedOwner) return false;
  }
  return true;
}

function exactVaultAgentAdditiveMigration(before, after) {
  const oldTable = before.tables.vault_agents;
  const newTable = after.tables.vault_agents;
  if (!oldTable || !newTable
      || !/UNIQUE\s*\(\s*owner_user_id\s*,\s*mention\s*\)/iu.test(newTable.schema.sql)) {
    return false;
  }
  const oldNames = new Set(oldTable.columns.map((column) => column.name));
  const expectedAdditions = [
    ...(!oldNames.has('hermes_profile') ? [
      { name: 'hermes_profile', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { name: 'hermes_safe_mode', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    ] : []),
    ...(!oldNames.has('identity_scope') ? [
      { name: 'identity_scope', type: 'TEXT', notnull: 1, dflt_value: "'network'", pk: 0 },
      { name: 'expires_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    ] : []),
  ];
  const additions = newTable.columns.slice(oldTable.columns.length);
  if (!expectedAdditions.length || !same(additions.map(({ name, type, notnull, dflt_value, pk }) => (
    { name, type, notnull, dflt_value, pk }
  )), expectedAdditions)) return false;
  if (!same(oldTable.columns, newTable.columns.slice(0, oldTable.columns.length))
      || !same(oldTable.normalizedForeignKeys, newTable.normalizedForeignKeys)
      || oldTable.rows.count !== newTable.rows.count
      || oldTable.rows.includesRowid !== newTable.rows.includesRowid) return false;
  for (const column of oldTable.rows.columns) {
    if (oldTable.rows.columnSha256[column] !== newTable.rows.columnSha256[column]) return false;
  }
  const oldRows = before.compatibility.vaultAgentHermes || [];
  const newRows = after.compatibility.vaultAgentHermes || [];
  return oldRows.length === newRows.length && oldRows.every((oldRow, index) => {
    const newRow = newRows[index];
    return newRow?.rowid === oldRow.rowid && newRow.id === oldRow.id
      && newRow.hermesProfile === oldRow.hermesProfile
      && newRow.hermesSafeMode === oldRow.hermesSafeMode
      && newRow.identityScope === 'network' && newRow.expiresAt === null;
  });
}

function exactChatAgentMemberAdditiveMigration(before, after) {
  const oldTable = before.tables.chat_agent_members;
  const newTable = after.tables.chat_agent_members;
  if (!oldTable || !newTable) return false;
  const oldNames = new Set(oldTable.columns.map((column) => column.name));
  const expectedName = oldNames.has('final_reply_only') ? 'next_step_suggestions'
    : oldNames.has('ambient_group_chat') ? 'final_reply_only' : 'ambient_group_chat';
  if (oldNames.has(expectedName)) return false;
  const added = newTable.columns.find((column) => column.name === expectedName);
  if (!added || added.type !== 'INTEGER' || Number(added.notnull) !== 1
      || added.dflt_value !== '0' || Number(added.pk) !== 0) return false;
  const oldColumns = oldTable.rows.columns;
  if (oldTable.rows.count !== newTable.rows.count
      || oldTable.rows.includesRowid !== newTable.rows.includesRowid
      || !oldColumns.every((column) => newTable.rows.columns.includes(column))
      || !same(oldTable.normalizedForeignKeys, newTable.normalizedForeignKeys)) return false;
  for (const column of oldColumns) {
    if (oldTable.rows.columnSha256[column] !== newTable.rows.columnSha256[column]) return false;
  }
  return newTable.schema.sqlSha256 === NORMALIZED_TABLE_SQL_SHA256.get('chat_agent_members');
}

export function verifyFtsIntegrity(filename, snapshot) {
  const ftsTables = Object.values(snapshot.tables)
    .filter((table) => table.rows.virtual && /\bUSING\s+fts5\s*\(/iu.test(table.schema.sql))
    .map((table) => table.schema.name);
  if (!ftsTables.length) return;

  const directory = databaseScratchDirectory('cascade-fts-integrity-');
  const disposable = path.join(directory, 'database.sqlite');
  try {
    fs.copyFileSync(filename, disposable);
    const db = new Database(disposable, { fileMustExist: true });
    try {
      for (const table of ftsTables) {
        db.exec('BEGIN');
        try {
          db.prepare(
            `INSERT INTO ${quoteIdentifier(table)}(${quoteIdentifier(table)}, rank) VALUES('integrity-check', 1)`,
          ).run();
          db.exec('ROLLBACK');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* preserve the integrity error */ }
          throw new Error(`FTS integrity check failed for ${table}: ${error.message}`);
        }
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fileTreeSnapshot(root) {
  const resolvedRoot = path.resolve(root);
  const entries = {};
  const visit = (directory, relativeDirectory = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      const stat = fs.lstatSync(absolute);
      const mode = stat.mode & 0o7777;
      if (entry.isDirectory()) {
        entries[relative] = { type: 'directory', mode };
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(absolute));
        entries[relative] = { type: 'file', mode, size: stat.size, sha256: hash.digest('hex') };
      } else if (entry.isSymbolicLink()) {
        entries[relative] = { type: 'symlink', mode, target: fs.readlinkSync(absolute) };
      } else {
        entries[relative] = { type: 'other', mode };
      }
    }
  };
  visit(resolvedRoot);
  return entries;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function commonFts5ShadowTables(before, after) {
  const virtualNames = (snapshot) => new Set(
    Object.values(snapshot.tables)
      .filter((table) => table.rows.virtual && /\bUSING\s+fts5\s*\(/iu.test(table.schema.sql))
      .map((table) => table.schema.name),
  );
  const beforeVirtual = virtualNames(before);
  const afterVirtual = virtualNames(after);
  const shadows = new Set();
  for (const table of beforeVirtual) {
    if (!afterVirtual.has(table)) continue;
    for (const suffix of FTS5_SHADOW_SUFFIXES) {
      const shadow = `${table}_${suffix}`;
      if (before.tables[shadow] && after.tables[shadow]) shadows.add(shadow);
    }
  }
  return shadows;
}

export function compareDatabaseSnapshots(before, after, allowedAdditions = DEFAULT_ALLOWED_ADDITIONS) {
  const failures = [];
  const beforeTables = new Set(Object.keys(before.tables));
  const afterTables = new Set(Object.keys(after.tables));
  const derivedFtsTables = commonFts5ShadowTables(before, after);
  for (const table of beforeTables) {
    if (!afterTables.has(table)) {
      failures.push(`table removed: ${table}`);
      continue;
    }
    if (derivedFtsTables.has(table)) continue;
    if (table === 'runs') {
      if (!exactRunOwnershipBackfill(before, after)) {
        const oldRows = before.tables[table].rows;
        const newRows = after.tables[table].rows;
        failures.push(
          `table changed outside pinned ownership migration: ${table} (rows ${oldRows.count}/${oldRows.sha256.slice(0, 12)} -> ${newRows.count}/${newRows.sha256.slice(0, 12)})`,
        );
      }
    } else if (table === 'vault_agents') {
      if (!same(before.tables[table], after.tables[table])
          && !exactVaultAgentAdditiveMigration(before, after)) {
        const oldRows = before.tables[table].rows;
        const newRows = after.tables[table].rows;
        failures.push(
          `table changed outside pinned agent identity migration: ${table} (rows ${oldRows.count}/${oldRows.sha256.slice(0, 12)} -> ${newRows.count}/${newRows.sha256.slice(0, 12)})`,
        );
      }
    } else if (table === 'chat_missions' && (exactMissionRecoveryMigration(before, after)
        || exactMissionRecoveryMigration(before, after, true))) {
      // Add only pinned empty defaults; preserve all existing mission values.
    } else if (table === 'chat_mission_tasks' && exactMissionChildMigration(before, after)) {
      // Existing tasks retain their values; new child state starts empty.
    } else if (table === 'chat_mission_tasks'
        && exactMissionWorkspaceModeMigration(before, after)) {
      // workspace_mode is an additive, default-shared mission task migration.
    } else if (table === 'delegated_runs' && exactDeliveryMigration(before, after)) {
      // Only empty delivery state may be added to historical leases.
    } else if (table === 'chat_agent_dispatches'
        && exactDispatchAdmissionMigration(before, after)) {
      // Admission columns remain NULL for historical dispatches.
    } else if (table === 'chat_agent_members'
        && exactChatAgentMemberAdditiveMigration(before, after)) {
      // The ambient participation flag is an additive, default-false migration.
    } else if (NORMALIZED_TABLE_SQL_SHA256.has(table)) {
      const oldTable = before.tables[table];
      const newTable = after.tables[table];
      const normalized = newTable.schema.sqlSha256 === NORMALIZED_TABLE_SQL_SHA256.get(table)
        && exactRowsOrMissionTaskBackfill(table, before, after)
        && same(oldTable.rows.columns, newTable.rows.columns)
        && same(oldTable.normalizedForeignKeys, newTable.normalizedForeignKeys);
      if (!normalized) {
        failures.push(
          `table changed outside pinned normalization: ${table} (rows ${oldTable.rows.count}/${oldTable.rows.sha256.slice(0, 12)} -> ${newTable.rows.count}/${newTable.rows.sha256.slice(0, 12)})`,
        );
      }
    } else if (!same(before.tables[table], after.tables[table])) {
      const oldRows = before.tables[table].rows;
      const newRows = after.tables[table].rows;
      failures.push(
        `table changed: ${table} (rows ${oldRows.count}/${oldRows.sha256.slice(0, 12)} -> ${newRows.count}/${newRows.sha256.slice(0, 12)})`,
      );
    }
  }
  for (const table of afterTables) {
    if (beforeTables.has(table)) continue;
    if (EMPTY_TABLE_ADDITIONS.has(table)) {
      const added = after.tables[table];
      if (added.schema.sqlSha256 !== EMPTY_TABLE_ADDITIONS.get(table) || added.rows.count !== 0) {
        failures.push(`${table} addition differs from pinned empty schema`);
      }
      continue;
    }
    if (!allowedAdditions.has(table)) {
      failures.push(`unexpected table added: ${table}`);
      continue;
    }
    if (table === 'cascade_elixir_schema_migrations') {
      const added = after.tables[table];
      const [migration] = added.migrationRows || [];
      if (added.schema.sqlSha256 !== MIGRATION_LEDGER_SQL_SHA256
          || added.migrationRows?.length !== 1
          || migration?.version !== MIGRATION_LEDGER_ROW.version
          || migration?.name !== MIGRATION_LEDGER_ROW.name
          || migration?.checksum !== MIGRATION_LEDGER_ROW.checksum
          || !Number.isFinite(Date.parse(`${migration?.applied_at || ''}Z`))) {
        failures.push('migration ledger addition differs from the pinned release migration');
      }
    }
  }

  for (const [key, object] of Object.entries(before.schema)) {
    if (object.type === 'table') continue;
    if (!after.schema[key]) failures.push(`${object.type} removed: ${object.name}`);
    else if (!same(object, after.schema[key])) {
      const expected = NORMALIZED_OBJECT_SQL_SHA256.get(key);
      if (!expected || after.schema[key].sqlSha256 !== expected) {
        failures.push(`${object.type} changed: ${object.name}`);
      }
    }
  }
  for (const [key, object] of Object.entries(after.schema)) {
    if (object.type === 'table' || before.schema[key]) continue;
    const expected = NORMALIZED_OBJECT_SQL_SHA256.get(key);
    if (expected) {
      if (object.sqlSha256 !== expected) failures.push(`${object.type} addition differs from pinned schema: ${object.name}`);
    } else if (!allowedAdditions.has(object.tableName) && !allowedAdditions.has(object.name)) {
      failures.push(`unexpected ${object.type} added: ${object.name}`);
    }
  }
  return failures;
}

export function compareIdenticalSnapshots(before, after) {
  const failures = [];
  if (!same(before.schema, after.schema)) failures.push('database schema changed');

  // FTS5 may merge or repack its data/idx shadow pages when an unchanged
  // logical index is opened by a new process. Compare the virtual table and
  // content table exactly, and verify integrity separately, but do not treat
  // the engine's private physical representation as application state.
  const derivedFtsTables = commonFts5ShadowTables(before, after);
  const tables = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
  for (const table of tables) {
    if (!before.tables[table]) failures.push(`table added: ${table}`);
    else if (!after.tables[table]) failures.push(`table removed: ${table}`);
    else if (derivedFtsTables.has(table)) continue;
    else if (!same(before.tables[table], after.tables[table])) {
      failures.push(`table changed during rolling preflight: ${table}`);
    }
  }
  if (!same(before.compatibility, after.compatibility)) {
    failures.push('compatibility projections changed during rolling preflight');
  }
  return failures;
}

export function compareSchemasExactly(before, after) {
  const failures = [];
  if (!same(before.schema, after.schema)) failures.push('database schema changed');

  const beforeLedger = before.tables.cascade_elixir_schema_migrations?.migrationRows || [];
  const afterLedger = after.tables.cascade_elixir_schema_migrations?.migrationRows || [];
  if (!same(beforeLedger, afterLedger)) failures.push('migration ledger changed');
  return failures;
}

export function validatePinnedElixirSchema(before, after) {
  const failures = [];
  const derivedFtsTables = commonFts5ShadowTables(before, after);
  for (const [table, oldTable] of Object.entries(before.tables)) {
    const next = after.tables[table];
    if (!next) {
      failures.push(`table removed: ${table}`);
      continue;
    }
    if (derivedFtsTables.has(table)) continue;
    const normalized = NORMALIZED_TABLE_SQL_SHA256.get(table);
    if (table === 'runs') {
      if (!exactRunOwnershipSchema(before, after)) {
        failures.push(`table schema differs from pinned ownership migration: ${table}`);
      }
    } else if (normalized) {
      if (next.schema.sqlSha256 !== normalized
          || !same(oldTable.rows.columns, next.rows.columns)
          || !same(oldTable.normalizedForeignKeys, next.normalizedForeignKeys)) {
        failures.push(`table schema differs from pinned normalization: ${table}`);
      }
    } else if (!same(oldTable.schema, next.schema)
        || !same(oldTable.rows.columns, next.rows.columns)
        || !same(oldTable.normalizedForeignKeys, next.normalizedForeignKeys)) {
      failures.push(`table schema changed: ${table}`);
    }
  }
  for (const table of Object.keys(after.tables)) {
    if (before.tables[table] || derivedFtsTables.has(table)
        || table === 'cascade_elixir_schema_migrations') continue;
    failures.push(`unexpected table added: ${table}`);
  }
  const migration = after.tables.cascade_elixir_schema_migrations;
  const [migrationRow] = migration?.migrationRows || [];
  if (migration?.schema.sqlSha256 !== MIGRATION_LEDGER_SQL_SHA256
      || migration?.migrationRows?.length !== 1
      || migrationRow?.version !== MIGRATION_LEDGER_ROW.version
      || migrationRow?.name !== MIGRATION_LEDGER_ROW.name
      || migrationRow?.checksum !== MIGRATION_LEDGER_ROW.checksum
      || !Number.isFinite(Date.parse(`${migrationRow?.applied_at || ''}Z`))) {
    failures.push('migration ledger differs from the pinned release migration');
  }
  for (const [key, object] of Object.entries(before.schema)) {
    if (object.type === 'table') continue;
    const next = after.schema[key];
    if (!next) failures.push(`${object.type} removed: ${object.name}`);
    else if (!same(object, next)) {
      const expected = NORMALIZED_OBJECT_SQL_SHA256.get(key);
      if (!expected || next.sqlSha256 !== expected) failures.push(`${object.type} changed: ${object.name}`);
    }
  }
  for (const [key, object] of Object.entries(after.schema)) {
    if (object.type === 'table' || before.schema[key]) continue;
    const expected = NORMALIZED_OBJECT_SQL_SHA256.get(key);
    if (expected) {
      if (object.sqlSha256 !== expected) failures.push(`${object.type} addition differs from pinned schema: ${object.name}`);
    } else if (object.tableName !== 'cascade_elixir_schema_migrations') {
      failures.push(`unexpected ${object.type} added: ${object.name}`);
    }
  }
  return failures;
}

function tableCountFromFingerprint(fingerprint) {
  return (fingerprint.objects || []).filter((object) => object.type === 'table').length;
}

export function runComparison(options) {
  if (options.schemaOnly) {
    const before = options.beforeFingerprint || loadSchemaFingerprint(options.beforeSchema || options.before);
    const after = options.afterFingerprint || loadSchemaFingerprint(options.afterSchema || options.after);
    const failures = compareSchemaFingerprints(before, after);
    return {
      ok: failures.length === 0,
      failures,
      beforeTables: tableCountFromFingerprint(before),
      afterTables: tableCountFromFingerprint(after),
    };
  }

  const allowed = new Set([...DEFAULT_ALLOWED_ADDITIONS, ...(options.allowTable || [])]);
  const before = databaseSnapshot(options.before);
  const after = databaseSnapshot(options.after);
  const failures = options.requireIdentical
    ? compareIdenticalSnapshots(before, after)
    : compareDatabaseSnapshots(before, after, allowed);
  try {
    verifyFtsIntegrity(options.after, after);
  } catch (error) {
    failures.push(error.message);
  }
  if (options.beforeRoot) {
    const beforeFiles = fileTreeSnapshot(options.beforeRoot);
    const afterFiles = fileTreeSnapshot(options.afterRoot);
    if (!same(beforeFiles, afterFiles)) failures.push('vault file tree changed');
  }
  return {
    ok: failures.length === 0,
    failures,
    beforeTables: Object.keys(before.tables).length,
    afterTables: Object.keys(after.tables).length,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dumpSchema) {
    process.stdout.write(`${JSON.stringify(readSchemaFingerprint(args.dumpSchema))}\n`);
    return;
  }
  if (args.materializeSchema) {
    const fingerprint = loadSchemaFingerprint(args.materializeSchema);
    materializeSchemaFingerprint(fingerprint, args.materializeDest);
    console.log(`Materialized schema into ${args.materializeDest}.`);
    return;
  }
  const result = runComparison(args);
  if (!result.ok) {
    console.error('Elixir data compatibility check failed:');
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (args.requireIdentical) {
    console.log(
      `Rolling data identity check passed: ${result.beforeTables} existing tables; ${result.afterTables} tables after boot.`,
    );
  } else if (args.schemaOnly) {
    console.log(
      `Rolling schema identity check passed: ${result.beforeTables} existing tables; ${result.afterTables} tables after boot.`,
    );
  } else {
    console.log(
      `Elixir data compatibility check passed: ${result.beforeTables} existing tables unchanged; ${result.afterTables} tables after boot.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { fileTreeSnapshot, parseArgs };
