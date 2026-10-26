import sanitizeHtml from 'sanitize-html'

const LINK_SCHEME = /^(https?|ftp|mailto|magnet):/i

/**
 * HTML of a message cut to what the spec lets clients render (`m.room.message`,
 * « HTML »), less `img`: the page serves no media a post only links to.
 */
export function sanitizeFormatted(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'del',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'p',
      'a',
      'ul',
      'ol',
      'sup',
      'sub',
      'li',
      'b',
      'i',
      'u',
      'strong',
      'em',
      's',
      'code',
      'hr',
      'br',
      'div',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'caption',
      'pre',
      'span',
      'details',
      'summary'
    ],
    allowedAttributes: {
      a: ['href', 'rel'],
      ol: ['start'],
      span: ['data-mx-spoiler']
    },
    allowedClasses: { code: ['language-*'] },
    allowedSchemes: ['https', 'http', 'ftp', 'mailto', 'magnet'],
    allowProtocolRelative: false,
    // The quoted message of a reply fallback is not part of the post
    nonTextTags: [
      'style',
      'script',
      'textarea',
      'option',
      'noscript',
      'mx-reply'
    ],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          // The spec allows no relative link
          ...(attribs.href && LINK_SCHEME.test(attribs.href)
            ? { href: attribs.href }
            : {}),
          rel: 'nofollow ugc noopener'
        }
      })
    }
  })
}
