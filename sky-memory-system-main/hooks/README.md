# Moltbot Integration Hooks

To make proactive recall work automatically, you need to hook into Moltbot's message processing pipeline.

## The Hook

Create a `message:received` hook that calls `proactive_recall.py` before your agent processes each message.

### Example Hook Handler (TypeScript)

```typescript
// hooks/proactive-recall/handler.ts
import { execSync } from 'child_process';
import type { HookHandler } from 'moltbot/hooks';

const PROACTIVE_SCRIPT = '/path/to/proactive_recall.py';

const handler: HookHandler = async (event) => {
  if (event.type === 'message' && event.action === 'received') {
    try {
      const body = (event.context as any)?.body;
      
      if (!body || typeof body !== 'string' || body.length < 10) {
        return;
      }

      const escaped = body.replace(/'/g, "'\\''");
      const result = execSync(
        `python3 ${PROACTIVE_SCRIPT} '${escaped}' 2>/dev/null`,
        { encoding: 'utf8', timeout: 15000 }
      );

      if (!result.trim()) return;

      const recall = JSON.parse(result);
      if (!recall.triggered) return;

      // Use pre-formatted context block (includes entities + memories)
      const lines = [
        '[Proactive Memory Recall - relevant context from your memories:]',
        '',
        recall.context_block,
        '',
        '[End of recalled context]',
        ''
      ];

      // Inject into context for your agent to see
      (event.context as any).injectedContext = lines.join('\n');

    } catch (err) {
      // Silent failure - don't break the response flow
      console.error('[proactive-recall] Error:', err);
    }
  }
};

export default handler;
```

### Moltbot Configuration

Add to your gateway config:

```yaml
hooks:
  enabled: true
  token: "your-hook-token"
  dirs:
    - "/path/to/hooks"
```

## Without Moltbot

If you're not using Moltbot, you can still use the proactive recall system:

1. **Manual injection**: Call `proactive_recall.py` with the user's message before your prompt
2. **Wrapper script**: Create a wrapper that injects context before passing to your agent
3. **API integration**: Call the recall function from your own message handler

The key is: **inject relevant context BEFORE the agent processes the message**, not after.

## Testing

```bash
# Test recall manually
python proactive_recall.py "What do you remember about Gerald?"

# Should return JSON with memories and/or entity context
```

## Common Issues

1. **API key not found**: Set GEMINI_API_KEY environment variable
2. **ChromaDB not initialized**: Run `memory_indexer.py` first
3. **Knowledge DB not found**: Create with the SQL schema
4. **Hook not firing**: Check hooks.enabled and token in config
