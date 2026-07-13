import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { AIHttpProxy, buildAiEndpoint, resolveAiCredential } from '../electron/aiHttpProxy'
import { createDefaultSettings } from '../electron/store'

async function withServer(
  handler: http.RequestListener,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

describe('AI HTTP proxy', () => {
  it('resolves only configured credential sources and endpoints', () => {
    const settings = createDefaultSettings()
    settings.ai.apiMode = 'openai-compatible'
    settings.ai.apiKey = 'main-key'
    settings.ai.baseUrl = 'https://api.example.test/v1'
    settings.aiProfiles = [
      {
        id: 'claude-profile',
        name: 'Claude',
        apiMode: 'claude',
        apiKey: 'profile-key',
        baseUrl: 'https://claude.example.test/v1',
        model: 'claude-test',
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    const main = resolveAiCredential(settings, { kind: 'main' })
    const profile = resolveAiCredential(settings, { kind: 'profile', profileId: 'claude-profile' })
    expect(buildAiEndpoint(main).toString()).toBe('https://api.example.test/v1/chat/completions')
    expect(buildAiEndpoint(profile).toString()).toBe('https://claude.example.test/v1/messages')
    expect(() => resolveAiCredential(settings, { kind: 'profile', profileId: 'missing' })).toThrow(
      'AI profile was not found',
    )
  })

  it('injects the configured key in the main process request', async () => {
    await withServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          path: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }),
      )
    }, async (origin) => {
      const settings = createDefaultSettings()
      settings.ai.apiKey = 'main-process-secret'
      settings.ai.baseUrl = `${origin}/v1`
      const proxy = new AIHttpProxy(() => settings)

      const result = await proxy.request({
        credential: { kind: 'main' },
        body: { model: 'test-model', messages: [] },
      })
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.bodyText)).toEqual({
        path: '/v1/chat/completions',
        authorization: 'Bearer main-process-secret',
        body: { model: 'test-model', messages: [] },
      })
    })
  })

  it('uses profile credentials and Claude headers in the main process', async () => {
    await withServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          path: request.url,
          apiKey: request.headers['x-api-key'],
          anthropicVersion: request.headers['anthropic-version'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }),
      )
    }, async (origin) => {
      const settings = createDefaultSettings()
      settings.aiProfiles = [
        {
          id: 'vision-claude',
          name: 'Vision Claude',
          apiMode: 'claude',
          apiKey: 'profile-process-secret',
          baseUrl: `${origin}/v1`,
          model: 'claude-test',
          createdAt: 1,
          updatedAt: 1,
        },
      ]
      const proxy = new AIHttpProxy(() => settings)

      const result = await proxy.request({
        credential: { kind: 'profile', profileId: 'vision-claude' },
        body: { model: 'claude-test', messages: [] },
      })
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.bodyText)).toEqual({
        path: '/v1/messages',
        apiKey: 'profile-process-secret',
        anthropicVersion: '2023-06-01',
        body: { model: 'claude-test', messages: [] },
      })
    })
  })

  it('forwards streaming bytes only to the requesting webContents', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"delta":"hello"}\n\n')
      response.end('data: [DONE]\n\n')
    }, async (origin) => {
      const settings = createDefaultSettings()
      settings.ai.apiKey = 'stream-secret'
      settings.ai.baseUrl = `${origin}/v1`
      const proxy = new AIHttpProxy(() => settings)
      const events: Array<{ channel: string; data: unknown }> = []
      let resolveDone: (() => void) | null = null
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      const sender = {
        id: 42,
        isDestroyed: () => false,
        send: (channel: string, data: unknown) => {
          events.push({ channel, data })
          if (channel === 'ai:httpStreamDone') resolveDone?.()
        },
      } as unknown as WebContents

      const start = await proxy.startStream(sender, {
        streamId: 'stream_test_1234',
        credential: { kind: 'main' },
        body: { model: 'test-model', stream: true, messages: [] },
      })
      expect(start.ok).toBe(true)
      await done

      const chunks = events
        .filter((event) => event.channel === 'ai:httpStreamChunk')
        .map((event) => Buffer.from((event.data as { chunk: Uint8Array }).chunk).toString('utf8'))
        .join('')
      expect(chunks).toContain('hello')
      expect(events.at(-1)?.channel).toBe('ai:httpStreamDone')
      expect(proxy.cancelStream(7, 'stream_test_1234')).toEqual({ ok: true })
    })
  })
})
