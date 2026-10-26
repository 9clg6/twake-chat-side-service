import { describe, expect, it } from 'vitest'
import { sanitizeFormatted } from './render.ts'

describe('sanitizeFormatted', () => {
  it('keeps the tags of the spec and drops scripts and handlers', () => {
    expect(
      sanitizeFormatted(
        '<p onclick="x()"><strong>Hi</strong><script>alert(1)</script></p>'
      )
    ).toBe('<p><strong>Hi</strong></p>')
  })

  it('keeps absolute links of the allowed schemes only, with rel', () => {
    expect(sanitizeFormatted('<a href="https://twake.app">t</a>')).toBe(
      '<a href="https://twake.app" rel="nofollow ugc noopener">t</a>'
    )
    expect(sanitizeFormatted('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a rel="nofollow ugc noopener">x</a>'
    )
    expect(sanitizeFormatted('<a href="/health/live">x</a>')).toBe(
      '<a rel="nofollow ugc noopener">x</a>'
    )
  })

  it('drops images and the quote of a reply fallback', () => {
    expect(
      sanitizeFormatted(
        '<mx-reply><blockquote>quoted</blockquote></mx-reply>answer<img src="https://evil.example/t.png">'
      )
    ).toBe('answer')
  })

  it('keeps the language class of code only', () => {
    expect(sanitizeFormatted('<code class="language-ts other">x</code>')).toBe(
      '<code class="language-ts">x</code>'
    )
  })
})
