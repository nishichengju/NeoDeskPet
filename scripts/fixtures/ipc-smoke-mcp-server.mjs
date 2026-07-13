import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'

const server = new McpServer({ name: 'neodeskpet-ipc-smoke-mmvector', version: '1.0.0' })

server.registerTool(
  'search_by_text',
  {
    description: 'Return an empty deterministic video search result for the packaged IPC smoke test.',
    inputSchema: {
      query: z.string(),
      topK: z.number().optional(),
      filter: z.string().optional(),
      minScore: z.number().optional(),
    },
  },
  async ({ query }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, query, results: [] }),
      },
    ],
  }),
)

server.registerTool(
  'capture_image',
  {
    description: 'Return one deterministic PNG for the packaged direct MCP media smoke test.',
    inputSchema: {},
  },
  async () => ({
    content: [
      { type: 'text', text: 'IPC MCP image captured.' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
