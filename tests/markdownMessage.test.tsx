import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownMessage } from '../src/components/MarkdownMessage'

describe('MarkdownMessage', () => {
  it('renders GFM content and safe external links', () => {
    const html = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: '**Bold**\n\n- [x] Done\n\n[OpenAI](https://openai.com)',
    }))

    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer"')
  })

  it('keeps thinking blocks collapsible while rendering their markdown', () => {
    const html = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: '<think>**Reasoning**</think>\n\nAnswer',
    }))

    expect(html).toContain('ndp-think')
    expect(html).toContain('<strong>Reasoning</strong>')
    expect(html).toContain('<p>Answer</p>')
  })
})
