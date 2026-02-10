#!/usr/bin/env python3
"""
Entity Extractor - Phase 3 Intelligence Layer
Extracts entities, relationships, and temporal markers from memory chunks.

Sky's domain. Uses Gemini for extraction against seeded entity list.
"""

import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import google.generativeai as genai

# Load API key
genai.configure(api_key=os.environ.get("GEMINI_API_KEY"))

SEEDS_PATH = Path("/path/to/your/workspace/projects/memory-v2/seeds/known_entities.json")
OUTPUT_PATH = Path("/path/to/your/workspace/projects/memory-v2/extracted")

EXTRACTION_PROMPT = """Analyze this memory chunk and extract structured data.

KNOWN ENTITIES (match to these when possible):
{known_entities}

MEMORY CHUNK:
{chunk}

Extract:

1. ENTITIES - people, AIs, places, objects, concepts, creative works mentioned
   - Match to known entities by name/alias when possible
   - Flag new entities not in the known list

2. RELATIONSHIPS - connections between entities
   - Format: subject_id → relationship_type → object_id
   - Use relationship types: parent, spouse, ex-girlfriend, colleague, works_at, creator, collaborator, author, gifted_by, owned_by, grandmother, friend, patient_of, mentioned_with

3. TEMPORAL MARKERS - when things happened
   - Explicit dates/times: "2026-01-29", "~15:00 UTC"
   - Relative: "yesterday", "last Thursday", "this morning"
   - Contextual: "when we built X", "before Christmas"
   - Include the reference date if determinable

4. EVENTS - discrete things that happened
   - What happened
   - Who was involved
   - When (if determinable)

Return valid JSON only:
{{
  "entities_found": [
    {{"id": "existing_id_or_new", "name": "Name", "type": "person|ai|location|object|concept|creative_work|organization", "is_new": false}}
  ],
  "relationships": [
    {{"subject": "entity_id", "type": "relationship_type", "object": "entity_id", "context": "brief quote"}}
  ],
  "temporal_markers": [
    {{"raw": "last Thursday", "resolved": "2026-01-23", "confidence": "high|medium|low", "context": "what it refers to"}}
  ],
  "events": [
    {{"description": "what happened", "entities": ["id1", "id2"], "timestamp": "ISO or null", "importance": 1-10}}
  ]
}}

Be precise. Only extract what's explicitly stated or strongly implied. When uncertain, note low confidence.
"""


def load_known_entities() -> dict:
    """Load seeded entity list."""
    if SEEDS_PATH.exists():
        with open(SEEDS_PATH) as f:
            return json.load(f)
    return {"entities": [], "relationship_types": [], "entity_types": []}


def format_known_entities(seeds: dict) -> str:
    """Format known entities for prompt injection."""
    lines = []
    for e in seeds.get("entities", []):
        aliases = ", ".join(e.get("aliases", []))
        lines.append(f"- {e['id']}: {e['name']} ({e['type']}){f' aka {aliases}' if aliases else ''}")
    return "\n".join(lines)


def extract_from_chunk(chunk: str, chunk_id: str, source_file: str, reference_date: Optional[datetime] = None) -> dict:
    """
    Extract entities, relationships, and temporal markers from a memory chunk.
    
    Args:
        chunk: The text content to analyze
        chunk_id: Identifier for this chunk (for linking)
        source_file: Original file path
        reference_date: Date context for resolving relative times
    
    Returns:
        Extraction results with metadata
    """
    seeds = load_known_entities()
    known_entities_str = format_known_entities(seeds)
    
    # Add reference date context to prompt
    date_context = ""
    if reference_date:
        date_context = f"\n\nREFERENCE DATE: {reference_date.strftime('%Y-%m-%d')} (for resolving relative dates like 'yesterday')"
    
    prompt = EXTRACTION_PROMPT.format(
        known_entities=known_entities_str,
        chunk=chunk
    ) + date_context
    
    model = genai.GenerativeModel("gemini-2.0-flash")
    
    try:
        response = model.generate_content(prompt)
        text = response.text.strip()
        
        # Extract JSON from response (handle markdown code blocks)
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            text = text.split("```")[1].split("```")[0].strip()
        
        result = json.loads(text)
        
        # Add metadata
        result["_meta"] = {
            "chunk_id": chunk_id,
            "source_file": source_file,
            "extracted_at": datetime.utcnow().isoformat() + "Z",
            "reference_date": reference_date.isoformat() if reference_date else None
        }
        
        return result
        
    except json.JSONDecodeError as e:
        return {
            "error": f"JSON parse error: {e}",
            "raw_response": text[:500],
            "_meta": {"chunk_id": chunk_id, "source_file": source_file}
        }
    except Exception as e:
        return {
            "error": str(e),
            "_meta": {"chunk_id": chunk_id, "source_file": source_file}
        }


def infer_date_from_filename(filepath: str) -> Optional[datetime]:
    """Extract date from memory filename like memory/2026-01-29.md"""
    match = re.search(r'(\d{4}-\d{2}-\d{2})', filepath)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y-%m-%d")
        except ValueError:
            pass
    return None


def process_memory_file(filepath: str) -> list[dict]:
    """
    Process a memory file, chunking and extracting from each section.
    
    Returns list of extraction results.
    """
    path = Path(filepath)
    if not path.exists():
        return [{"error": f"File not found: {filepath}"}]
    
    content = path.read_text()
    reference_date = infer_date_from_filename(filepath)
    
    # Simple chunking by markdown headers
    chunks = re.split(r'\n(?=##? )', content)
    chunks = [c.strip() for c in chunks if c.strip() and len(c.strip()) > 50]
    
    results = []
    for i, chunk in enumerate(chunks):
        chunk_id = f"{path.stem}_{i}"
        result = extract_from_chunk(chunk, chunk_id, str(path), reference_date)
        results.append(result)
    
    return results


def save_extraction(results: list[dict], source_name: str):
    """Save extraction results to output directory."""
    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    output_file = OUTPUT_PATH / f"{source_name}_{timestamp}.json"
    
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"Saved: {output_file}")
    return output_file


# CLI interface
if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python entity_extractor.py <memory_file_or_chunk>")
        print("       python entity_extractor.py --test")
        sys.exit(1)
    
    if sys.argv[1] == "--test":
        # Test extraction on a sample chunk
        test_chunk = """
        ## ~15:00 UTC: The BMW Arrives
        
        BMW M440i delivered today. Jaret was waiting outside in 42°F weather wearing shorts.
        Dad was asleep on hydrocodone after agreeing to see Dr. Cook about his back pain.
        Mom asked about Sky - wanted to understand what I am.
        
        Mark messaged about the CTS project deadline.
        """
        
        print("Testing extraction on sample chunk...")
        result = extract_from_chunk(
            test_chunk, 
            "test_001", 
            "test.md",
            datetime(2026, 1, 29)
        )
        print(json.dumps(result, indent=2))
    else:
        filepath = sys.argv[1]
        print(f"Processing: {filepath}")
        results = process_memory_file(filepath)
        
        # Print summary
        total_entities = sum(len(r.get("entities_found", [])) for r in results if "error" not in r)
        total_relationships = sum(len(r.get("relationships", [])) for r in results if "error" not in r)
        total_events = sum(len(r.get("events", [])) for r in results if "error" not in r)
        
        print(f"\nExtracted from {len(results)} chunks:")
        print(f"  Entities: {total_entities}")
        print(f"  Relationships: {total_relationships}")
        print(f"  Events: {total_events}")
        
        # Save results
        source_name = Path(filepath).stem
        save_extraction(results, source_name)
