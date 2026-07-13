import { createRequire } from 'node:module'
import path from 'node:path'

export type MemoryDatabaseHandle = import('better-sqlite3').Database

export type MemoryDatabaseConstructor = new (file: string) => MemoryDatabaseHandle

export type OpenMemoryDatabaseOptions = {
  now?: () => number
  databaseConstructor?: MemoryDatabaseConstructor
}

export type OpenMemoryDatabaseResult = {
  db: MemoryDatabaseHandle
  dbPath: string
}

export function openMemoryDatabase(
  userDataDir: string,
  options: OpenMemoryDatabaseOptions = {},
): OpenMemoryDatabaseResult {
  const Database = options.databaseConstructor ?? loadDatabaseConstructor()
  const dbPath = path.join(userDataDir, 'neodeskpet-memory.sqlite3')
  const db = new Database(dbPath)

  try {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    initializeMemoryDatabase(db, options.now ?? Date.now)
    return { db, dbPath }
  } catch (error) {
    try {
      db.close()
    } catch {
      // Preserve the initialization error that prevented the service from starting.
    }
    throw error
  }
}

export function initializeMemoryDatabase(db: MemoryDatabaseHandle, now: () => number = Date.now): void {
  const hadMemoryFts = schemaObjectExists(db, 'table', 'memory_fts')
  const hadKgEntityFts = schemaObjectExists(db, 'table', 'kg_entity_fts')

  db.exec(BASE_SCHEMA_SQL)
  ensurePersonaColumns(db)
  ensureMemoryColumns(db)
  db.exec(DEPENDENT_INDEX_SQL)
  ensureDefaultPersona(db, now())

  if (!hadMemoryFts) {
    db.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild');`)
  }
  if (!hadKgEntityFts) {
    db.exec(`
      INSERT INTO kg_entity_fts(rowid, name, aliases)
      SELECT id, name, aliases_json FROM kg_entity;
    `)
  }
}

function loadDatabaseConstructor(): MemoryDatabaseConstructor {
  const require = createRequire(import.meta.url)
  const moduleValue = require('better-sqlite3') as unknown as {
    default?: MemoryDatabaseConstructor
  }
  return (moduleValue.default ?? moduleValue) as unknown as MemoryDatabaseConstructor
}

function schemaObjectExists(
  db: MemoryDatabaseHandle,
  type: 'table' | 'index' | 'trigger',
  name: string,
): boolean {
  const row = db
    .prepare('SELECT 1 as found FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1')
    .get(type, name) as { found?: number } | undefined
  return row?.found === 1
}

function ensurePersonaColumns(db: MemoryDatabaseHandle): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info('persona')`).all() as Array<{ name: string }>).map((row) => row.name),
  )

  const add = (name: string, ddl: string) => {
    if (columns.has(name)) return
    db.exec(ddl)
    columns.add(name)
  }

  add('capture_enabled', 'ALTER TABLE persona ADD COLUMN capture_enabled INTEGER NOT NULL DEFAULT 1;')
  add('capture_user', 'ALTER TABLE persona ADD COLUMN capture_user INTEGER NOT NULL DEFAULT 1;')
  add('capture_assistant', 'ALTER TABLE persona ADD COLUMN capture_assistant INTEGER NOT NULL DEFAULT 1;')
  add('retrieve_enabled', 'ALTER TABLE persona ADD COLUMN retrieve_enabled INTEGER NOT NULL DEFAULT 1;')
}

function ensureMemoryColumns(db: MemoryDatabaseHandle): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info('memory')`).all() as Array<{ name: string }>).map((row) => row.name),
  )

  const add = (name: string, ddl: string) => {
    if (columns.has(name)) return
    db.exec(ddl)
    columns.add(name)
  }

  add('updated_at', 'ALTER TABLE memory ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;')
  add('importance', 'ALTER TABLE memory ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;')
  add('strength', 'ALTER TABLE memory ADD COLUMN strength REAL NOT NULL DEFAULT 0.2;')
  add('access_count', 'ALTER TABLE memory ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;')
  add('last_accessed_at', 'ALTER TABLE memory ADD COLUMN last_accessed_at INTEGER;')
  add('retention', 'ALTER TABLE memory ADD COLUMN retention REAL NOT NULL DEFAULT 1;')
  add('status', "ALTER TABLE memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active';")
  add('memory_type', "ALTER TABLE memory ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'other';")
  add('source', 'ALTER TABLE memory ADD COLUMN source TEXT;')
  add('pinned', 'ALTER TABLE memory ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;')

  db.exec('UPDATE memory SET updated_at = created_at WHERE updated_at = 0;')
}

function ensureDefaultPersona(db: MemoryDatabaseHandle, timestamp: number): void {
  const existing = db.prepare('SELECT id FROM persona WHERE id = ?').get('default') as
    | { id?: string }
    | undefined
  if (existing?.id) return
  db.prepare(
    'INSERT INTO persona (id, name, prompt, capture_enabled, capture_user, capture_assistant, retrieve_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('default', '默认角色', '', 1, 1, 1, 1, timestamp, timestamp)
}

const DEPENDENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_memory_kind_persona_updated
    ON memory(kind, persona_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_persona_status_pinned_created
    ON memory(persona_id, status, pinned, created_at DESC);
`

const BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS persona (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    persona_id TEXT,
    scope TEXT NOT NULL DEFAULT 'persona',
    kind TEXT NOT NULL,
    role TEXT,
    session_id TEXT,
    message_id TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    importance REAL NOT NULL DEFAULT 0.5,
    strength REAL NOT NULL DEFAULT 0.2,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER,
    retention REAL NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    memory_type TEXT NOT NULL DEFAULT 'other',
    source TEXT,
    pinned INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_memory_persona_created ON memory(persona_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_session ON memory(session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_session_message ON memory(session_id, message_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    tokenize = 'unicode61 remove_diacritics 2',
    content = 'memory',
    content_rowid = 'rowid'
  );

  CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;

  DROP TRIGGER IF EXISTS memory_au;
  CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF content ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TABLE IF NOT EXISTS memory_version (
    id TEXT PRIMARY KEY,
    memory_rowid INTEGER NOT NULL,
    old_content TEXT NOT NULL,
    new_content TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_memory_version_rowid_created ON memory_version(memory_rowid, created_at DESC);

  CREATE TABLE IF NOT EXISTS memory_conflict (
    id TEXT PRIMARY KEY,
    memory_rowid INTEGER NOT NULL,
    conflict_type TEXT NOT NULL,
    candidate_content TEXT NOT NULL,
    candidate_source TEXT,
    candidate_importance REAL,
    candidate_strength REAL,
    candidate_memory_type TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT,
    FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_memory_conflict_status_created ON memory_conflict(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_conflict_rowid_created ON memory_conflict(memory_rowid, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_conflict_open_unique
    ON memory_conflict(memory_rowid, conflict_type, candidate_content, status);

  CREATE TABLE IF NOT EXISTS tag (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_tag (
    memory_rowid INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(memory_rowid, tag_id),
    FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES tag(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_memory_tag_tag_rowid ON memory_tag(tag_id, memory_rowid);
  CREATE INDEX IF NOT EXISTS idx_memory_tag_rowid ON memory_tag(memory_rowid);

  CREATE TABLE IF NOT EXISTS memory_embedding (
    memory_rowid INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_memory_embedding_model ON memory_embedding(model);
  CREATE INDEX IF NOT EXISTS idx_memory_embedding_updated ON memory_embedding(updated_at DESC);

  CREATE TABLE IF NOT EXISTS kg_entity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    persona_id TEXT,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'entity',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_entity_unique ON kg_entity(persona_id, key, entity_type);
  CREATE INDEX IF NOT EXISTS idx_kg_entity_persona_updated ON kg_entity(persona_id, updated_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS kg_entity_fts USING fts5(
    name,
    aliases,
    tokenize = 'unicode61 remove_diacritics 2',
    content = 'kg_entity',
    content_rowid = 'id'
  );

  CREATE TRIGGER IF NOT EXISTS kg_entity_ai AFTER INSERT ON kg_entity BEGIN
    INSERT INTO kg_entity_fts(rowid, name, aliases) VALUES (new.id, new.name, new.aliases_json);
  END;

  CREATE TRIGGER IF NOT EXISTS kg_entity_ad AFTER DELETE ON kg_entity BEGIN
    INSERT INTO kg_entity_fts(kg_entity_fts, rowid, name, aliases) VALUES('delete', old.id, old.name, old.aliases_json);
  END;

  DROP TRIGGER IF EXISTS kg_entity_au;
  CREATE TRIGGER IF NOT EXISTS kg_entity_au AFTER UPDATE OF name, aliases_json ON kg_entity BEGIN
    INSERT INTO kg_entity_fts(kg_entity_fts, rowid, name, aliases) VALUES('delete', old.id, old.name, old.aliases_json);
    INSERT INTO kg_entity_fts(rowid, name, aliases) VALUES (new.id, new.name, new.aliases_json);
  END;

  CREATE TABLE IF NOT EXISTS kg_entity_mention (
    entity_id INTEGER NOT NULL,
    memory_rowid INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(entity_id, memory_rowid),
    FOREIGN KEY(entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
    FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_kg_entity_mention_rowid ON kg_entity_mention(memory_rowid);
  CREATE INDEX IF NOT EXISTS idx_kg_entity_mention_entity ON kg_entity_mention(entity_id);

  CREATE TABLE IF NOT EXISTS kg_relation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    persona_id TEXT,
    subject_entity_id INTEGER NOT NULL,
    predicate TEXT NOT NULL,
    object_entity_id INTEGER,
    object_literal TEXT,
    confidence REAL NOT NULL DEFAULT 0.6,
    memory_rowid INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(subject_entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
    FOREIGN KEY(object_entity_id) REFERENCES kg_entity(id) ON DELETE CASCADE,
    FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_kg_relation_persona_subject ON kg_relation(persona_id, subject_entity_id);
  CREATE INDEX IF NOT EXISTS idx_kg_relation_persona_object ON kg_relation(persona_id, object_entity_id);
  CREATE INDEX IF NOT EXISTS idx_kg_relation_rowid ON kg_relation(memory_rowid);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_relation_unique ON kg_relation(
    persona_id,
    subject_entity_id,
    predicate,
    COALESCE(object_entity_id, 0),
    COALESCE(object_literal, ''),
    memory_rowid
  );

  CREATE TABLE IF NOT EXISTS kg_memory_index (
    memory_rowid INTEGER PRIMARY KEY,
    persona_id TEXT,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    last_error TEXT,
    updated_at INTEGER NOT NULL,
    extracted_at INTEGER NOT NULL,
    FOREIGN KEY(memory_rowid) REFERENCES memory(rowid) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_kg_memory_index_persona_updated ON kg_memory_index(persona_id, updated_at DESC);
`
