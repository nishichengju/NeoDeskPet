#!/usr/bin/env python3
"""
Memory Indexer v2
Embeds memory files into ChromaDB for semantic recall
+ Entity extraction to knowledge graph (Phase 3)

Run via cron every 30 minutes
"""

import os
import hashlib
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
import chromadb
from chromadb.config import Settings
import google.generativeai as genai

# Add extractors to path for entity extraction
sys.path.insert(0, str(Path(__file__).parent / "extractors"))

# Load API key from .env.sky
def load_api_key():
    env_file = Path.home() / ".env.sky"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("GEMINI_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
                os.environ["GEMINI_API_KEY"] = key
                return key
    return os.environ.get("GEMINI_API_KEY")

GEMINI_API_KEY = load_api_key()
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
else:
    print("WARNING: No GEMINI_API_KEY found!")

# Configuration
MEMORY_DIRS = [
    Path("/path/to/your/workspace/memory"),
    Path("/path/to/your/workspace/jaret"),
    Path("/path/to/your/workspace/creative"),
    Path("/path/to/your/workspace/journal"),
]
CORE_FILES = [
    Path("/path/to/your/workspace/MEMORY.md"),
    Path("/path/to/your/workspace/USER.md"),
    Path("/path/to/your/workspace/NOW.md"),
    Path("/path/to/your/workspace/VIBE.txt"),
]
CHROMA_PATH = Path.home() / ".agent-memory" / "chroma"
STATE_FILE = Path.home() / ".agent-memory" / "indexer-state.json"
CHUNK_SIZE = 1000  # characters per chunk
CHUNK_OVERLAP = 200

# Initialize
CHROMA_PATH.mkdir(parents=True, exist_ok=True)

def get_gemini_embedding(text: str) -> list[float]:
    """Get embedding from Gemini."""
    result = genai.embed_content(
        model="models/text-embedding-004",
        content=text,
        task_type="retrieval_document"
    )
    return result['embedding']

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk)
        start = end - overlap
    return chunks

def get_file_hash(filepath: Path) -> str:
    """Get hash of file content for change detection."""
    return hashlib.md5(filepath.read_bytes()).hexdigest()

def load_state() -> dict:
    """Load indexer state."""
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"indexed_files": {}}

def save_state(state: dict):
    """Save indexer state."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))

def extract_importance(filepath: Path, content: str) -> float:
    """Estimate importance score based on file and content."""
    score = 0.5  # base score
    
    # Boost core files
    if filepath.name in ["MEMORY.md", "USER.md", "NOW.md"]:
        score += 0.3
    
    # Boost files with emotional markers
    emotional_markers = ["love", "miss", "proud", "scared", "happy", "sad", "important", "remember"]
    for marker in emotional_markers:
        if marker.lower() in content.lower():
            score += 0.05
    
    # Boost recent files
    if filepath.parent.name == "memory":
        try:
            date_str = filepath.stem  # YYYY-MM-DD
            file_date = datetime.strptime(date_str, "%Y-%m-%d")
            days_old = (datetime.now() - file_date).days
            if days_old < 7:
                score += 0.2
            elif days_old < 30:
                score += 0.1
        except:
            pass
    
    return min(score, 1.0)

def get_all_memory_files() -> list[Path]:
    """Get all files to index."""
    files = list(CORE_FILES)
    
    for dir_path in MEMORY_DIRS:
        if dir_path.exists():
            files.extend(dir_path.rglob("*.md"))
            files.extend(dir_path.rglob("*.txt"))
    
    # Deduplicate and filter
    seen = set()
    result = []
    for f in files:
        if f.exists() and f.is_file() and str(f) not in seen:
            seen.add(str(f))
            result.append(f)
    
    return result

def index_file(collection, filepath: Path, state: dict) -> int:
    """Index a single file. Returns number of chunks indexed."""
    file_hash = get_file_hash(filepath)
    file_key = str(filepath)
    
    # Skip if unchanged
    if file_key in state["indexed_files"]:
        if state["indexed_files"][file_key]["hash"] == file_hash:
            return 0
        # File changed - delete old chunks first
        try:
            old_ids = state["indexed_files"][file_key].get("chunk_ids", [])
            if old_ids:
                collection.delete(ids=old_ids)
        except:
            pass
    
    # Read and chunk
    try:
        content = filepath.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        print(f"  Error reading {filepath}: {e}")
        return 0
    
    if len(content.strip()) < 50:
        return 0
    
    chunks = chunk_text(content)
    if not chunks:
        return 0
    
    # Calculate importance
    importance = extract_importance(filepath, content)
    
    # Embed and store
    chunk_ids = []
    for i, chunk in enumerate(chunks):
        chunk_id = f"{file_key}:{i}:{file_hash[:8]}"
        
        try:
            embedding = get_gemini_embedding(chunk)
            
            collection.add(
                ids=[chunk_id],
                embeddings=[embedding],
                documents=[chunk],
                metadatas=[{
                    "source": str(filepath),
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "importance": importance,
                    "indexed_at": datetime.now(timezone.utc).isoformat(),
                    "file_modified": datetime.fromtimestamp(filepath.stat().st_mtime).isoformat(),
                }]
            )
            chunk_ids.append(chunk_id)
        except Exception as e:
            print(f"  Error embedding chunk {i}: {e}")
    
    # Update state
    state["indexed_files"][file_key] = {
        "hash": file_hash,
        "chunk_ids": chunk_ids,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
    }
    
    return len(chunk_ids)

# Entity extraction configuration
EXTRACT_ENTITIES = True  # Set False to skip entity extraction
KNOWLEDGE_DB = Path.home() / ".agent-memory" / "knowledge.db"


def extract_entities_from_file(filepath: Path, state: dict) -> dict:
    """
    Extract entities from a file and populate the knowledge graph.
    Returns stats about extraction.
    """
    stats = {"entities": 0, "relationships": 0, "events": 0, "temporal": 0}
    
    if not EXTRACT_ENTITIES:
        return stats
    
    if not KNOWLEDGE_DB.exists():
        print("  ⚠ Knowledge DB not found, skipping extraction")
        return stats
    
    try:
        from entity_extractor import process_memory_file
        from sqlite_writer import process_extraction_file
        
        # Check if already extracted (use same hash as embedding)
        file_key = str(filepath)
        file_hash = get_file_hash(filepath)
        
        extracted_key = f"extracted:{file_key}"
        if extracted_key in state.get("extracted_files", {}):
            if state["extracted_files"][extracted_key] == file_hash:
                return stats  # Already extracted this version
        
        # Extract entities
        extractions = process_memory_file(str(filepath))
        
        if not extractions or all("error" in e for e in extractions):
            return stats
        
        # Write to temp file then process
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(extractions, f)
            temp_path = Path(f.name)
        
        try:
            from sqlite_writer import process_extraction_file
            result = process_extraction_file(temp_path)
            stats = {
                "entities": result.get("entities", 0),
                "relationships": result.get("relationships", 0),
                "events": result.get("events", 0),
                "temporal": result.get("temporal", 0),
            }
        finally:
            temp_path.unlink()  # Clean up temp file
        
        # Update state
        if "extracted_files" not in state:
            state["extracted_files"] = {}
        state["extracted_files"][extracted_key] = file_hash
        
    except ImportError as e:
        print(f"  ⚠ Entity extraction not available: {e}")
    except Exception as e:
        print(f"  ⚠ Entity extraction error: {e}")
    
    return stats


def main():
    print("=" * 50)
    print("Memory Indexer v2 + Entity Graph")
    print(f"Started: {datetime.now(timezone.utc).isoformat()}Z")
    print("=" * 50)
    
    # Initialize ChromaDB
    client = chromadb.PersistentClient(path=str(CHROMA_PATH))
    collection = client.get_or_create_collection(
        name="sky_memory",
        metadata={"description": "Sky's memory vectors"}
    )
    
    print(f"ChromaDB initialized at {CHROMA_PATH}")
    print(f"Collection 'sky_memory' has {collection.count()} vectors")
    
    if EXTRACT_ENTITIES and KNOWLEDGE_DB.exists():
        print(f"Entity extraction: ENABLED")
    else:
        print(f"Entity extraction: DISABLED")
    
    # Load state
    state = load_state()
    
    # Get files
    files = get_all_memory_files()
    print(f"Found {len(files)} memory files")
    
    # Index
    total_chunks = 0
    total_extracted = {"entities": 0, "relationships": 0, "events": 0, "temporal": 0}
    
    for filepath in files:
        chunks_added = index_file(collection, filepath, state)
        if chunks_added > 0:
            print(f"  ✓ {filepath.name}: {chunks_added} chunks")
            total_chunks += chunks_added
            
            # Entity extraction for changed files
            if EXTRACT_ENTITIES:
                ext_stats = extract_entities_from_file(filepath, state)
                if any(ext_stats.values()):
                    print(f"    → entities:{ext_stats['entities']} rels:{ext_stats['relationships']} events:{ext_stats['events']}")
                    for k, v in ext_stats.items():
                        total_extracted[k] += v
    
    # Save state
    save_state(state)
    
    print("-" * 50)
    print(f"Indexed {total_chunks} new chunks")
    print(f"Collection now has {collection.count()} total vectors")
    if EXTRACT_ENTITIES and any(total_extracted.values()):
        print(f"Extracted: {total_extracted['entities']} entities, {total_extracted['relationships']} relationships, {total_extracted['events']} events")
    print(f"Completed: {datetime.now(timezone.utc).isoformat()}Z")


if __name__ == "__main__":
    main()
