-- Sky Memory System - Knowledge Graph Schema
-- Phase 3: Entities, Relationships, Events, Temporal

-- Entities: people, places, things, concepts
CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,  -- person, ai, organization, location, object, concept, creative_work
    aliases TEXT,        -- JSON array
    notes TEXT,
    emotional_weight REAL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Relationships between entities
CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity TEXT NOT NULL,
    to_entity TEXT NOT NULL,
    type TEXT NOT NULL,  -- parent, spouse, colleague, creator, etc.
    source_chunk TEXT,   -- which chunk established this
    timestamp TEXT,      -- when in the narrative
    FOREIGN KEY (from_entity) REFERENCES entities(id),
    FOREIGN KEY (to_entity) REFERENCES entities(id)
);

-- Events: discrete things that happened
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    timestamp TEXT,
    importance INTEGER CHECK (importance BETWEEN 1 AND 10),
    chunk_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Event-Entity junction: which entities were involved in which events
CREATE TABLE IF NOT EXISTS event_entities (
    event_id INTEGER NOT NULL,
    entity_id TEXT NOT NULL,
    role TEXT DEFAULT 'mentioned',  -- subject, object, mentioned
    FOREIGN KEY (event_id) REFERENCES events(id),
    FOREIGN KEY (entity_id) REFERENCES entities(id),
    PRIMARY KEY (event_id, entity_id)
);

-- Temporal index: when things happened in chunks
CREATE TABLE IF NOT EXISTS temporal (
    chunk_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    granularity TEXT DEFAULT 'day',  -- day, week, month, approximate
    extracted_from TEXT              -- filename or content
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_entity);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_entity);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_importance ON events(importance DESC);
CREATE INDEX IF NOT EXISTS idx_temporal_timestamp ON temporal(timestamp);
