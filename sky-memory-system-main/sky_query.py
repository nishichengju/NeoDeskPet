#!/usr/bin/env python3
"""
Sky Query Interface - Phase 3 Natural Language Queries

Routes queries to appropriate backend:
- "tell me about X" → entity graph
- "what happened on Y" → temporal + events
- "who is connected to Z" → graph traversal
- General questions → semantic search (ChromaDB)

Usage:
  python sky_query.py "tell me about Dez"
  python sky_query.py "what happened yesterday"
  python sky_query.py "who is connected to CTS"
"""

import sqlite3
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import chromadb
import google.generativeai as genai
import os

# Load API key
def load_api_key():
    env_file = Path.home() / ".env.sky"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("GEMINI_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
                return key
    return os.environ.get("GEMINI_API_KEY")

genai.configure(api_key=load_api_key())

# Paths
KNOWLEDGE_DB = Path.home() / ".agent-memory" / "knowledge.db"
CHROMA_PATH = Path.home() / ".agent-memory" / "chroma"
CENTRAL_TZ = ZoneInfo("America/Chicago")


def get_db():
    """Get SQLite connection."""
    return sqlite3.connect(KNOWLEDGE_DB)


def get_chroma():
    """Get ChromaDB collection."""
    client = chromadb.PersistentClient(path=str(CHROMA_PATH))
    return client.get_collection("sky_memory")


# === QUERY ROUTERS ===

def detect_query_type(query: str) -> str:
    """
    Detect what type of query this is.
    Returns: 'entity', 'temporal', 'graph', or 'semantic'
    """
    q = query.lower().strip()
    
    # Entity queries
    if re.match(r'^(tell me about|who is|what is|describe)\s+', q):
        return 'entity'
    
    # Temporal queries
    if re.match(r'^(what happened|when did|what did we do)\s+', q):
        return 'temporal'
    if any(word in q for word in ['yesterday', 'today', 'last week', 'this week', 'on monday', 'on tuesday']):
        return 'temporal'
    
    # Graph traversal
    if re.match(r'^(who is connected to|what.s related to|connections for)\s+', q):
        return 'graph'
    
    # Default to semantic
    return 'semantic'


def extract_entity_name(query: str) -> str:
    """Extract the entity name from a query."""
    q = query.lower().strip()
    
    # Remove common prefixes (order matters - longest first)
    prefixes = [
        r'^who is connected to\s+',
        r'^what\'?s related to\s+',
        r'^connections for\s+',
        r'^tell me about\s+',
        r'^who is\s+',
        r'^what is\s+',
        r'^describe\s+',
    ]
    
    for prefix in prefixes:
        q = re.sub(prefix, '', q)
    
    # Clean up
    q = q.strip().rstrip('?').strip()
    return q


def resolve_temporal_reference(query: str) -> tuple[str, str]:
    """
    Resolve temporal references to date range.
    Returns (start_date, end_date) as ISO strings.
    """
    now = datetime.now(CENTRAL_TZ)
    today = now.date()
    
    q = query.lower()
    
    if 'today' in q:
        return str(today), str(today)
    
    if 'yesterday' in q:
        yesterday = today - timedelta(days=1)
        return str(yesterday), str(yesterday)
    
    if 'this week' in q:
        # Monday of this week
        start = today - timedelta(days=today.weekday())
        return str(start), str(today)
    
    if 'last week' in q:
        # Previous Monday to Sunday
        this_monday = today - timedelta(days=today.weekday())
        last_monday = this_monday - timedelta(days=7)
        last_sunday = this_monday - timedelta(days=1)
        return str(last_monday), str(last_sunday)
    
    # Try to find explicit date
    date_match = re.search(r'(\d{4}-\d{2}-\d{2})', q)
    if date_match:
        d = date_match.group(1)
        return d, d
    
    # Default to last 7 days
    week_ago = today - timedelta(days=7)
    return str(week_ago), str(today)


# === QUERY HANDLERS ===

def query_entity(entity_name: str) -> dict:
    """Query everything about an entity."""
    conn = get_db()
    cursor = conn.cursor()
    
    result = {
        "entity": None,
        "relationships": [],
        "events": [],
        "mentioned_with": []
    }
    
    # Find entity (try exact match, then LIKE)
    cursor.execute("""
        SELECT id, name, type, aliases, notes, emotional_weight
        FROM entities 
        WHERE LOWER(id) = LOWER(?) OR LOWER(name) = LOWER(?)
        OR LOWER(aliases) LIKE ?
    """, (entity_name, entity_name, f'%{entity_name.lower()}%'))
    
    row = cursor.fetchone()
    if row:
        result["entity"] = {
            "id": row[0],
            "name": row[1],
            "type": row[2],
            "aliases": row[3],
            "notes": row[4],
            "emotional_weight": row[5]
        }
        entity_id = row[0]
        
        # Get relationships
        cursor.execute("""
            SELECT e.name, r.type, 'outgoing'
            FROM relationships r
            JOIN entities e ON r.to_entity = e.id
            WHERE r.from_entity = ?
            UNION
            SELECT e.name, r.type, 'incoming'
            FROM relationships r
            JOIN entities e ON r.from_entity = e.id
            WHERE r.to_entity = ?
        """, (entity_id, entity_id))
        result["relationships"] = [
            {"name": r[0], "type": r[1], "direction": r[2]}
            for r in cursor.fetchall()
        ]
        
        # Get events involving this entity
        cursor.execute("""
            SELECT DISTINCT e.description, e.timestamp, e.importance
            FROM events e
            JOIN event_entities ee ON e.id = ee.event_id
            WHERE ee.entity_id = ?
            ORDER BY e.importance DESC
            LIMIT 10
        """, (entity_id,))
        result["events"] = [
            {"description": r[0], "timestamp": r[1], "importance": r[2]}
            for r in cursor.fetchall()
        ]
    
    conn.close()
    return result


def query_temporal(start_date: str, end_date: str) -> dict:
    """Query events in a date range."""
    conn = get_db()
    cursor = conn.cursor()
    
    result = {
        "date_range": f"{start_date} to {end_date}",
        "events": [],
        "temporal_markers": []
    }
    
    # Get events in range
    cursor.execute("""
        SELECT description, timestamp, importance, chunk_id
        FROM events
        WHERE DATE(timestamp) BETWEEN ? AND ?
        ORDER BY timestamp, importance DESC
    """, (start_date, end_date))
    
    result["events"] = [
        {"description": r[0], "timestamp": r[1], "importance": r[2], "source": r[3]}
        for r in cursor.fetchall()
    ]
    
    # Get temporal markers in range
    cursor.execute("""
        SELECT timestamp, chunk_id, granularity
        FROM temporal
        WHERE DATE(timestamp) BETWEEN ? AND ?
        ORDER BY timestamp
    """, (start_date, end_date))
    
    result["temporal_markers"] = [
        {"timestamp": r[0], "source": r[1], "granularity": r[2]}
        for r in cursor.fetchall()
    ]
    
    conn.close()
    return result


def query_graph(entity_name: str) -> dict:
    """Query graph connections for an entity."""
    conn = get_db()
    cursor = conn.cursor()
    
    result = {
        "center": entity_name,
        "connections": []
    }
    
    # Find entity ID
    cursor.execute("""
        SELECT id FROM entities 
        WHERE LOWER(id) = LOWER(?) OR LOWER(name) = LOWER(?)
    """, (entity_name, entity_name))
    
    row = cursor.fetchone()
    if not row:
        conn.close()
        return result
    
    entity_id = row[0]
    
    # Get all connections (1 hop)
    cursor.execute("""
        SELECT e.name, e.type, r.type as rel_type, 'outgoing' as direction
        FROM relationships r
        JOIN entities e ON r.to_entity = e.id
        WHERE r.from_entity = ?
        UNION
        SELECT e.name, e.type, r.type as rel_type, 'incoming' as direction
        FROM relationships r
        JOIN entities e ON r.from_entity = e.id
        WHERE r.to_entity = ?
    """, (entity_id, entity_id))
    
    result["connections"] = [
        {"name": r[0], "type": r[1], "relationship": r[2], "direction": r[3]}
        for r in cursor.fetchall()
    ]
    
    conn.close()
    return result


def query_semantic(query: str, n_results: int = 5) -> dict:
    """Fall back to semantic search."""
    collection = get_chroma()
    
    # Get embedding for query
    result = genai.embed_content(
        model="models/text-embedding-004",
        content=query,
        task_type="retrieval_query"
    )
    query_embedding = result['embedding']
    
    # Search
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=n_results,
        include=["documents", "metadatas", "distances"]
    )
    
    return {
        "query": query,
        "results": [
            {
                "content": doc[:500] + "..." if len(doc) > 500 else doc,
                "source": meta.get("source", "unknown"),
                "similarity": 1 - dist  # Convert distance to similarity
            }
            for doc, meta, dist in zip(
                results["documents"][0],
                results["metadatas"][0],
                results["distances"][0]
            )
        ]
    }


# === MAIN ===

def format_entity_result(result: dict) -> str:
    """Format entity query result for display."""
    lines = []
    
    if not result["entity"]:
        return "Entity not found in knowledge graph."
    
    e = result["entity"]
    lines.append(f"## {e['name']} ({e['type']})")
    if e['notes']:
        lines.append(f"*{e['notes']}*")
    if e['emotional_weight']:
        lines.append(f"Emotional weight: {e['emotional_weight']}")
    
    if result["relationships"]:
        lines.append("\n**Relationships:**")
        for r in result["relationships"]:
            arrow = "→" if r["direction"] == "outgoing" else "←"
            lines.append(f"  {arrow} {r['type']}: {r['name']}")
    
    if result["events"]:
        lines.append("\n**Key events:**")
        for ev in result["events"][:5]:
            imp = "★" * min(ev["importance"] or 5, 5)
            lines.append(f"  [{imp}] {ev['description']}")
    
    return "\n".join(lines)


def format_temporal_result(result: dict) -> str:
    """Format temporal query result for display."""
    lines = [f"## Events: {result['date_range']}"]
    
    if not result["events"]:
        lines.append("No events found in this range.")
    else:
        for ev in result["events"]:
            ts = ev["timestamp"][:10] if ev["timestamp"] else "?"
            imp = ev["importance"] or 5
            lines.append(f"  [{ts}] ({imp}/10) {ev['description']}")
    
    return "\n".join(lines)


def format_graph_result(result: dict) -> str:
    """Format graph query result for display."""
    lines = [f"## Connections: {result['center']}"]
    
    if not result["connections"]:
        lines.append("No connections found.")
    else:
        for c in result["connections"]:
            arrow = "→" if c["direction"] == "outgoing" else "←"
            lines.append(f"  {arrow} {c['relationship']}: {c['name']} ({c['type']})")
    
    return "\n".join(lines)


def format_semantic_result(result: dict) -> str:
    """Format semantic search result for display."""
    lines = [f"## Semantic search: {result['query']}"]
    
    for i, r in enumerate(result["results"], 1):
        sim = f"{r['similarity']:.2f}"
        lines.append(f"\n**[{i}] ({sim})** {Path(r['source']).name}")
        lines.append(r["content"])
    
    return "\n".join(lines)


def query(q: str) -> str:
    """
    Main entry point. Route query and return formatted result.
    """
    query_type = detect_query_type(q)
    
    if query_type == 'entity':
        entity_name = extract_entity_name(q)
        result = query_entity(entity_name)
        return format_entity_result(result)
    
    elif query_type == 'temporal':
        start, end = resolve_temporal_reference(q)
        result = query_temporal(start, end)
        return format_temporal_result(result)
    
    elif query_type == 'graph':
        entity_name = extract_entity_name(q)
        result = query_graph(entity_name)
        return format_graph_result(result)
    
    else:
        result = query_semantic(q)
        return format_semantic_result(result)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python sky_query.py \"your question here\"")
        print("\nExamples:")
        print("  python sky_query.py \"tell me about Dez\"")
        print("  python sky_query.py \"what happened yesterday\"")
        print("  python sky_query.py \"who is connected to CTS\"")
        sys.exit(1)
    
    q = " ".join(sys.argv[1:])
    print(query(q))
