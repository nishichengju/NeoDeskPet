#!/usr/bin/env python3
"""
Proactive Memory Recall + Entity Injection (Phase 2 + Phase 4)

Takes incoming message text, finds:
  1. Relevant semantic memories (Phase 2)
  2. Structured entity context for mentioned entities (Phase 4)

Usage: 
  python3 proactive_recall.py "user message text"
  
Returns JSON with memories + entity context if relevant.
"""

import os
import sys
import json
import sqlite3
import re
from pathlib import Path
from datetime import datetime, timezone
import chromadb
import google.generativeai as genai

# Load API key
def _load_api_key():
    env_file = Path.home() / ".env.sky"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("GEMINI_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
                return key
    return os.environ.get("GEMINI_API_KEY")

_API_KEY = _load_api_key()
if _API_KEY:
    genai.configure(api_key=_API_KEY)

CHROMA_PATH = Path.home() / ".agent-memory" / "chroma"
KNOWLEDGE_DB = Path.home() / ".agent-memory" / "knowledge.db"
RELEVANCE_THRESHOLD = 0.55  # Only surface if above this
MAX_RESULTS = 3  # Don't overwhelm context
MAX_PREVIEW_CHARS = 300  # Keep context tight
MAX_ENTITIES = 2  # Don't inject too many entity profiles
MIN_ENTITY_WEIGHT = 0.3  # Skip low-importance entities


# === PHASE 4: ENTITY DETECTION & INJECTION ===

def load_entity_patterns() -> list[tuple[str, str, float]]:
    """
    Load known entities and their aliases for pattern matching.
    Returns list of (pattern, entity_id, emotional_weight).
    """
    if not KNOWLEDGE_DB.exists():
        return []
    
    patterns = []
    try:
        conn = sqlite3.connect(KNOWLEDGE_DB)
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT id, name, aliases, emotional_weight 
            FROM entities
        """)
        
        for row in cursor.fetchall():
            entity_id, name, aliases_json, weight = row
            weight = weight or 0.5
            
            # Add name as pattern (case-insensitive)
            patterns.append((name.lower(), entity_id, weight))
            
            # Add aliases
            if aliases_json:
                try:
                    aliases = json.loads(aliases_json)
                    for alias in aliases:
                        if alias and len(alias) > 1:  # Skip single chars
                            patterns.append((alias.lower(), entity_id, weight))
                except json.JSONDecodeError:
                    pass
        
        conn.close()
        
        # Sort by length descending (match longer patterns first)
        patterns.sort(key=lambda x: len(x[0]), reverse=True)
        
    except Exception as e:
        pass  # Fail silently, entity injection is optional
    
    return patterns


def detect_entities(message: str, patterns: list[tuple[str, str, float]]) -> list[str]:
    """
    Detect which known entities are mentioned in the message.
    Returns list of entity IDs (deduplicated, max MAX_ENTITIES).
    """
    message_lower = message.lower()
    found = {}  # entity_id -> weight
    
    for pattern, entity_id, weight in patterns:
        # Word boundary matching to avoid partial matches
        if re.search(r'\b' + re.escape(pattern) + r'\b', message_lower):
            if entity_id not in found or weight > found[entity_id]:
                found[entity_id] = weight
    
    # Filter by minimum weight and sort by weight
    filtered = [(eid, w) for eid, w in found.items() if w >= MIN_ENTITY_WEIGHT]
    filtered.sort(key=lambda x: x[1], reverse=True)
    
    return [eid for eid, _ in filtered[:MAX_ENTITIES]]


def get_entity_context(entity_id: str) -> dict | None:
    """
    Get full entity context from knowledge graph.
    Returns structured dict or None if not found.
    """
    if not KNOWLEDGE_DB.exists():
        return None
    
    try:
        conn = sqlite3.connect(KNOWLEDGE_DB)
        cursor = conn.cursor()
        
        # Get entity
        cursor.execute("""
            SELECT id, name, type, notes, emotional_weight
            FROM entities WHERE id = ?
        """, (entity_id,))
        
        row = cursor.fetchone()
        if not row:
            conn.close()
            return None
        
        entity = {
            "id": row[0],
            "name": row[1],
            "type": row[2],
            "notes": row[3],
            "emotional_weight": row[4]
        }
        
        # Get relationships (limit to most important)
        cursor.execute("""
            SELECT e.name, r.type, 'to' as direction
            FROM relationships r
            JOIN entities e ON r.to_entity = e.id
            WHERE r.from_entity = ?
            UNION
            SELECT e.name, r.type, 'from' as direction
            FROM relationships r
            JOIN entities e ON r.from_entity = e.id
            WHERE r.to_entity = ?
            LIMIT 5
        """, (entity_id, entity_id))
        
        entity["relationships"] = [
            {"name": r[0], "type": r[1], "direction": r[2]}
            for r in cursor.fetchall()
        ]
        
        # Get recent high-importance events (limit 3)
        cursor.execute("""
            SELECT DISTINCT e.description, e.importance
            FROM events e
            JOIN event_entities ee ON e.id = ee.event_id
            WHERE ee.entity_id = ?
            ORDER BY e.importance DESC, e.id DESC
            LIMIT 3
        """, (entity_id,))
        
        entity["recent_events"] = [
            {"description": r[0], "importance": r[1]}
            for r in cursor.fetchall()
        ]
        
        conn.close()
        return entity
        
    except Exception as e:
        return None


def format_entity_context(entities: list[dict]) -> str:
    """Format entity contexts for injection."""
    if not entities:
        return ""
    
    lines = ["[Entity Context]"]
    
    for e in entities:
        lines.append(f"• {e['name']} ({e['type']})")
        
        if e.get('notes'):
            lines.append(f"  Notes: {e['notes'][:100]}")
        
        if e.get('emotional_weight') and e['emotional_weight'] > 0.7:
            lines.append(f"  Emotional weight: {e['emotional_weight']}")
        
        if e.get('relationships'):
            rels = [f"{r['type']}→{r['name']}" for r in e['relationships'][:3]]
            lines.append(f"  Relationships: {', '.join(rels)}")
        
        if e.get('recent_events'):
            events = [ev['description'][:60] for ev in e['recent_events'][:2]]
            lines.append(f"  Recent: {'; '.join(events)}")
    
    return "\n".join(lines)


def get_embedding(text: str) -> list[float]:
    """Get embedding from Gemini."""
    result = genai.embed_content(
        model="models/text-embedding-004",
        content=text,
        task_type="retrieval_query"
    )
    return result['embedding']


def proactive_recall(message: str) -> dict:
    """
    Find relevant memories AND entity context for incoming message.
    
    Returns dict with:
      - triggered: bool (whether anything relevant was found)
      - memories: list of {source, score, preview} (Phase 2)
      - entities: list of entity contexts (Phase 4)
      - context_block: formatted string for injection (combined)
    """
    result = {
        "triggered": False,
        "memories": [],
        "entities": [],
        "context_block": ""
    }
    
    # Skip very short messages
    if len(message.strip()) < 10:
        return result
    
    context_parts = []
    
    # === PHASE 4: Entity Detection & Injection ===
    try:
        patterns = load_entity_patterns()
        if patterns:
            detected_ids = detect_entities(message, patterns)
            if detected_ids:
                entity_contexts = []
                for eid in detected_ids:
                    ctx = get_entity_context(eid)
                    if ctx:
                        entity_contexts.append(ctx)
                
                if entity_contexts:
                    result["entities"] = entity_contexts
                    result["triggered"] = True
                    context_parts.append(format_entity_context(entity_contexts))
    except Exception as e:
        pass  # Entity injection is optional, don't fail the whole recall
    
    # === PHASE 2: Semantic Memory Recall ===
    if not CHROMA_PATH.exists():
        if result["triggered"]:
            result["context_block"] = "\n\n".join(context_parts)
        return result
    
    try:
        # Get embedding for message
        query_vec = get_embedding(message)
        
        # Search ChromaDB
        client = chromadb.PersistentClient(path=str(CHROMA_PATH))
        collection = client.get_collection("sky_memory")
        
        results = collection.query(
            query_embeddings=[query_vec],
            n_results=MAX_RESULTS * 2,  # Get extra to filter
            include=["documents", "metadatas", "distances"]
        )
        
        if not results["documents"] or not results["documents"][0]:
            return {"triggered": False, "memories": [], "context_block": ""}
        
        memories = []
        for i, (doc, meta, dist) in enumerate(zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0]
        )):
            # ChromaDB returns L2 distance, convert to similarity
            # For normalized vectors: similarity ≈ 1 - (distance²/2)
            similarity = max(0, 1 - (dist / 2))
            
            if similarity >= RELEVANCE_THRESHOLD:
                source = meta.get("source", "unknown")
                # Clean up source path for display
                if "/" in source:
                    source = source.split("/")[-1]
                
                preview = doc[:MAX_PREVIEW_CHARS]
                if len(doc) > MAX_PREVIEW_CHARS:
                    preview += "..."
                
                memories.append({
                    "source": source,
                    "score": round(similarity, 2),
                    "preview": preview,
                    "importance": meta.get("importance", 0.5)
                })
        
        # Sort by score, take top N
        memories.sort(key=lambda x: x["score"], reverse=True)
        memories = memories[:MAX_RESULTS]
        
        if memories:
            result["memories"] = memories
            result["triggered"] = True
            
            # Build semantic memory context
            memory_lines = ["[Semantic Memory]"]
            for m in memories:
                memory_lines.append(f"• {m['source']} ({m['score']}): {m['preview'][:150]}...")
            context_parts.append("\n".join(memory_lines))
        
    except Exception as e:
        result["error"] = str(e)
    
    # Combine all context parts
    if context_parts:
        result["context_block"] = "\n\n".join(context_parts)
    
    return result


def main():
    if len(sys.argv) < 2:
        print("Usage: proactive_recall.py 'message text'")
        sys.exit(1)
    
    message = " ".join(sys.argv[1:])
    result = proactive_recall(message)
    
    if result["triggered"]:
        print(json.dumps(result, indent=2))
    else:
        # Silent when nothing found - don't pollute output
        pass


if __name__ == "__main__":
    main()
