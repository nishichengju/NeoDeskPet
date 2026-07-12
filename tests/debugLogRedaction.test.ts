import { describe, expect, it } from 'vitest'
import { redactSensitiveLogData } from '../electron/debugLog'

describe('debug log redaction', () => {
  it('redacts nested credentials without removing numeric token usage', () => {
    const redacted = redactSensitiveLogData({
      apiKey: 'sk-main-secret',
      orchestrator: { toolAiApiKey: 'sk-tool-secret' },
      headers: { Authorization: 'Bearer abc.def.ghi', Cookie: 'session=secret' },
      usage: { promptTokens: 120, completion_tokens: 30 },
      url: 'https://example.test/v1?access_token=url-secret&mode=test',
    })

    expect(redacted).toEqual({
      apiKey: '[REDACTED]',
      orchestrator: { toolAiApiKey: '[REDACTED]' },
      headers: { Authorization: '[REDACTED]', Cookie: '[REDACTED]' },
      usage: { promptTokens: 120, completion_tokens: 30 },
      url: 'https://example.test/v1?access_token=[REDACTED]&mode=test',
    })
  })

  it('redacts credentials embedded in messages and handles circular input', () => {
    const input: Record<string, unknown> = {
      message: 'request failed: Authorization=Bearer top-secret',
      detail: 'password=hunter2',
    }
    input.self = input

    expect(redactSensitiveLogData(input)).toEqual({
      message: 'request failed: Authorization=[REDACTED]',
      detail: 'password=[REDACTED]',
      self: '[Circular]',
    })
  })
})
