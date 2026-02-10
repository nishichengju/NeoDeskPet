#!/usr/bin/env python3
"""
SQLite Writer - Phase 3 Bridge
Takes entity_extractor.py JSON output and populates the knowledge graph DB.

Sky's domain. Writes to Orion's schema.
"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DB_PATH = Path("/home/skybot/.memory-v2/knowledge.db")
EXTRACTED_PATH = Path("/path/to/your/workspace/projects/memory-v2/extracted")


def get_connection() -> sqlite3.Connection:
    """Get DB connection with foreign keys enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def now_iso() -> str:
    """Current timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat()


def upsert_entity(conn: sqlite3.Connection, entity: dict, source_chunk: str = None):
    """
    Insert or update an entity.
    
    If entity exists: update notes/aliases if new info
    If entity is new: insert with is_new flag consideration
    """
    entity_id = entity.get("id", "").lower().replace(" ", "_")
    if not entity_id or entity_id == "new":
        # Generate ID from name for new entities
        entity_id = entity.get("name", "unknown").lower().replace(" ", "_").replace(".", "")
    
    name = entity.get("name", entity_id)
    entity_type = entity.get("type", "unknown")
    is_new = entity.get("is_new", False)
    
    cursor = conn.cursor()
    
    # Check if exists
    cursor.execute("SELECT id, notes FROM entities WHERE id = ?", (entity_id,))
    existing = cursor.fetchone()
    
    now = now_iso()
    
    if existing:
        # Update timestamp
        cursor.execute(
            "UPDATE entities SET updated_at = ? WHERE id = ?",
            (now, entity_id)
        )
    else:
        # Insert new entity
        notes = f"Auto-extracted from {source_chunk}" if is_new else None
        cursor.execute(
            """INSERT INTO entities (id, name, type, aliases, notes, emotional_weight, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (entity_id, name, entity_type, "[]", notes, 0.5 if is_new else None, now, now)
        )
    
    return entity_id


def insert_relationship(conn: sqlite3.Connection, rel: dict, source_chunk: str):
    """Insert a relationship between entities."""
    from_entity = rel.get("subject", "").lower().replace(" ", "_")
    to_entity = rel.get("object", "").lower().replace(" ", "_")
    rel_type = rel.get("type", "related_to")
    context = rel.get("context", "")
    
    # Handle "new" placeholder for new entities
    if from_entity == "new":
        from_entity = context.lower().replace(" ", "_")[:50] if context else "unknown"
    if to_entity == "new":
        to_entity = context.lower().replace(" ", "_")[:50] if context else "unknown"
    
    cursor = conn.cursor()
    
    # Check for duplicate
    cursor.execute(
        """SELECT id FROM relationships 
           WHERE from_entity = ? AND to_entity = ? AND type = ?""",
        (from_entity, to_entity, rel_type)
    )
    if cursor.fetchone():
        return  # Already exists
    
    cursor.execute(
        """INSERT INTO relationships (from_entity, to_entity, type, source_chunk, timestamp)
           VALUES (?, ?, ?, ?, ?)""",
        (from_entity, to_entity, rel_type, source_chunk, now_iso())
    )


def insert_event(conn: sqlite3.Connection, event: dict, chunk_id: str) -> int:
    """Insert an event and return its ID."""
    cursor = conn.cursor()
    
    cursor.execute(
        """INSERT INTO events (description, timestamp, importance, chunk_id, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (
            event.get("description", ""),
            event.get("timestamp"),
            event.get("importance", 5),
            chunk_id,
            now_iso()
        )
    )
    return cursor.lastrowid


def link_event_entity(conn: sqlite3.Connection, event_id: int, entity_id: str, role: str = "mentioned"):
    """Link an event to an entity."""
    cursor = conn.cursor()
    
    # Normalize entity_id
    entity_id = entity_id.lower().replace(" ", "_")
    
    try:
        cursor.execute(
            """INSERT OR IGNORE INTO event_entities (event_id, entity_id, role)
               VALUES (?, ?, ?)""",
            (event_id, entity_id, role)
        )
    except sqlite3.IntegrityError:
        pass  # Entity doesn't exist yet, skip


def insert_temporal(conn: sqlite3.Connection, marker: dict, chunk_id: str):
    """Insert a temporal marker."""
    cursor = conn.cursor()
    
    resolved = marker.get("resolved", "")
    confidence = marker.get("confidence", "medium")
    
    # Determine granularity from confidence
    granularity = "day" if confidence == "high" else "approximate"
    
    cursor.execute(
        """INSERT INTO temporal (chunk_id, timestamp, granularity, extracted_from)
           VALUES (?, ?, ?, ?)""",
        (chunk_id, resolved, granularity, marker.get("context", "content"))
    )


def process_extraction_file(filepath: Path) -> dict:
    """
    Process a JSON extraction file and populate the database.
    
    Returns stats about what was inserted.
    """
    with open(filepath) as f:
        extractions = json.load(f)
    
    stats = {
        "entities": 0,
        "relationships": 0,
        "events": 0,
        "temporal": 0,
        "errors": []
    }
    
    conn = get_connection()
    
    try:
        for extraction in extractions:
            if "error" in extraction:
                stats["errors"].append(extraction["error"])
                continue
            
            meta = extraction.get("_meta", {})
            chunk_id = meta.get("chunk_id", "unknown")
            source_file = meta.get("source_file", "unknown")
            
            # Process entities
            for entity in extraction.get("entities_found", []):
                try:
                    upsert_entity(conn, entity, source_file)
                    stats["entities"] += 1
                except Exception as e:
                    stats["errors"].append(f"Entity error: {e}")
            
            # Process relationships
            for rel in extraction.get("relationships", []):
                try:
                    insert_relationship(conn, rel, chunk_id)
                    stats["relationships"] += 1
                except Exception as e:
                    stats["errors"].append(f"Relationship error: {e}")
            
            # Process events
            for event in extraction.get("events", []):
                try:
                    event_id = insert_event(conn, event, chunk_id)
                    stats["events"] += 1
                    
                    # Link entities to event
                    for i, entity_id in enumerate(event.get("entities", [])):
                        role = "subject" if i == 0 else "mentioned"
                        link_event_entity(conn, event_id, entity_id, role)
                except Exception as e:
                    stats["errors"].append(f"Event error: {e}")
            
            # Process temporal markers
            for marker in extraction.get("temporal_markers", []):
                try:
                    insert_temporal(conn, marker, chunk_id)
                    stats["temporal"] += 1
                except Exception as e:
                    stats["errors"].append(f"Temporal error: {e}")
        
        conn.commit()
        
    except Exception as e:
        conn.rollback()
        stats["errors"].append(f"Transaction error: {e}")
    finally:
        conn.close()
    
    return stats


def process_all_extractions() -> dict:
    """Process all JSON files in the extracted directory."""
    total_stats = {
        "files": 0,
        "entities": 0,
        "relationships": 0,
        "events": 0,
        "temporal": 0,
        "errors": []
    }
    
    for json_file in EXTRACTED_PATH.glob("*.json"):
        print(f"Processing: {json_file.name}")
        stats = process_extraction_file(json_file)
        
        total_stats["files"] += 1
        total_stats["entities"] += stats["entities"]
        total_stats["relationships"] += stats["relationships"]
        total_stats["events"] += stats["events"]
        total_stats["temporal"] += stats["temporal"]
        total_stats["errors"].extend(stats["errors"])
    
    return total_stats


# CLI
if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python sqlite_writer.py <extraction.json | --all>")
        print("       --all processes all files in extracted/")
        sys.exit(1)
    
    if not DB_PATH.exists():
        print(f"ERROR: Database not found at {DB_PATH}")
        print("Orion needs to create it first with the schema.")
        sys.exit(1)
    
    if sys.argv[1] == "--all":
        stats = process_all_extractions()
        print(f"\nProcessed {stats['files']} file(s):")
    else:
        filepath = Path(sys.argv[1])
        if not filepath.exists():
            print(f"ERROR: File not found: {filepath}")
            sys.exit(1)
        stats = process_extraction_file(filepath)
        print(f"\nProcessed {filepath.name}:")
    
    print(f"  Entities: {stats['entities']}")
    print(f"  Relationships: {stats['relationships']}")
    print(f"  Events: {stats['events']}")
    print(f"  Temporal: {stats['temporal']}")
    
    if stats["errors"]:
        print(f"\n  Errors ({len(stats['errors'])}):")
        for err in stats["errors"][:5]:
            print(f"    - {err}")
        if len(stats["errors"]) > 5:
            print(f"    ... and {len(stats['errors']) - 5} more")
