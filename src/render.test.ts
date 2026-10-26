import { describe, expect, it } from 'vitest'
import type { Page, Post } from './pages.ts'
import { langOf, renderPage, sanitizeFormatted } from './render.ts'

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

const POST: Post = {
  id: '$1',
  author: 'Alice',
  at: 0,
  text: '<img src=x onerror=alert(1)> **bold**',
  formatted: null,
  image: null,
  reactions: { '👍': 1 }
}

const PAGE: Page = {
  ref: 'news',
  roomId: '!room:example.org',
  name: 'News <b>',
  topic: '',
  avatarUrl: null,
  coverUrl: null,
  accentColor: '#2b6cb0',
  followerCount: 2,
  posts: [POST]
}

describe('renderPage', () => {
  const html = renderPage(PAGE, {
    publicUrl: 'https://pages.example.org',
    chatUrl: 'https://chat.example.org',
    lang: 'en'
  })

  it('escapes the room and renders a plain body as Markdown without raw HTML', () => {
    expect(html).toContain('<h1>News &lt;b&gt;</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('<img src=x')
  })

  it('opens the room in Twake Chat (D398)', () => {
    expect(html).toContain(
      'href="https://chat.example.org/rooms/!room%3Aexample.org">React in Twake Chat</a>'
    )
  })

  it('shows the reactions of members, read only', () => {
    expect(html).toContain(
      '<ul class="reactions"><li aria-label="👍, 1 reaction">👍 1</li></ul>'
    )
    expect(html).not.toContain('<form')
  })

  it('keeps the text of a post with a spoiler out of the structured data', () => {
    const spoiler = renderPage(
      {
        ...PAGE,
        posts: [
          {
            ...POST,
            text: 'The butler did it',
            formatted: 'The <span data-mx-spoiler="">butler</span> did it'
          }
        ]
      },
      {
        publicUrl: 'https://pages.example.org',
        chatUrl: 'https://chat.example.org',
        lang: 'en'
      }
    )
    const data =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
        spoiler
      )?.[1]

    expect(data).toContain('SocialMediaPosting')
    expect(data).not.toContain('butler')
  })
})

describe('langOf', () => {
  it('speaks French to a visitor whose first language is French', () => {
    expect(langOf('fr-FR,fr;q=0.9,en;q=0.8')).toBe('fr')
    expect(langOf('en-US,fr;q=0.9')).toBe('en')
    expect(langOf(undefined)).toBe('en')
  })
})
