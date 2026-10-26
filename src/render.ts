import { readFileSync } from 'node:fs'
import MarkdownIt from 'markdown-it'
import sanitizeHtml from 'sanitize-html'
import { type Page, parseMxc, type Post } from './pages.ts'

// `templates/` sits beside `src/` and `dist/` alike
const TEMPLATES = new URL('../templates/', import.meta.url)
const template = (name: string) =>
  readFileSync(new URL(name, TEMPLATES), 'utf8')
const PAGE = template('page.html')
const POST = template('post.html')
const STYLE = template('page.css')
export const NOT_FOUND = template('not-found.html')

const DESCRIPTION_LIMIT = 300

const TEXTS = {
  en: {
    follower: 'follower',
    followers: 'followers',
    react: 'React in Twake Chat',
    posts: 'Posts',
    empty: 'Nothing posted yet.',
    reaction: (key: string, count: number) =>
      `${key}, ${String(count)} ${count === 1 ? 'reaction' : 'reactions'}`
  },
  fr: {
    follower: 'abonné',
    followers: 'abonnés',
    react: 'Réagir dans Twake Chat',
    posts: 'Publications',
    empty: "Rien n'est encore publié.",
    reaction: (key: string, count: number) =>
      `${key}, ${String(count)} ${count === 1 ? 'réaction' : 'réactions'}`
  }
}

/** The language of the page: French when the visitor's first language is, else English. */
export const langOf = (acceptLanguage: string | undefined): 'en' | 'fr' =>
  /^\s*fr\b/i.test(acceptLanguage ?? '') ? 'fr' : 'en'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The template with each `{{key}}` replaced by its value, which must be HTML already. */
function fill(source: string, values: Record<string, string>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`No value for {{${key}}}`)
    return value
  })
}

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

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })

/** The HTML of a post's text: its `formatted_body`, else its `body` read as Markdown. */
function textHtml(post: Post): string {
  return sanitizeFormatted(post.formatted ?? markdown.render(post.text))
}

/** The path of a page, on this service. */
export const pagePath = (ref: string): string => `/b/${encodeURIComponent(ref)}`

/** The path of a media of the page, on this service. */
function mediaPath(ref: string, mxc: string): string {
  const media = parseMxc(mxc)
  return `${pagePath(ref)}/media/${encodeURIComponent(media?.server ?? '')}/${encodeURIComponent(media?.id ?? '')}`
}

/** JSON inside a script element: no « < » may end it. */
const jsonForScript = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c')

/** Initials as Twake Chat draws them: first letter of the first and of the last word. */
function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  return [words[0], words.length > 1 ? words.at(-1) : undefined]
    .map(word => word?.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
    .join('')
    .toUpperCase()
}

function structuredData(
  page: Page,
  url: string,
  publicUrl: string,
  imageUrl: string | null
) {
  const description = page.topic.slice(0, DESCRIPTION_LIMIT)
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    name: page.name,
    mainEntity: {
      '@type': 'Organization',
      name: page.name,
      ...(description && { description }),
      ...(imageUrl && { image: imageUrl })
    },
    hasPart: page.posts.map(post => ({
      '@type': 'SocialMediaPosting',
      datePublished: new Date(post.at).toISOString(),
      author: { '@type': 'Person', name: post.author },
      // The body holds a spoiler in clear: crawlers get no text of such a post
      ...(post.text &&
        !post.formatted?.includes('data-mx-spoiler') && { text: post.text }),
      ...(post.image && {
        image: publicUrl + mediaPath(page.ref, post.image.url)
      })
    }))
  }
}

function reactionsHtml(post: Post, lang: 'en' | 'fr'): string {
  const chips = Object.entries(post.reactions).map(
    ([key, count]) =>
      `<li aria-label="${escapeHtml(TEXTS[lang].reaction(key, count))}">${escapeHtml(key)} ${String(count)}</li>`
  )
  return chips.length > 0 ? `<ul class="reactions">${chips.join('')}</ul>` : ''
}

function postHtml(page: Page, post: Post, lang: 'en' | 'fr'): string {
  const iso = new Date(post.at).toISOString()
  return fill(POST, {
    id: escapeHtml(post.id),
    author: escapeHtml(post.author),
    iso,
    date: iso.slice(0, 10),
    text: post.text ? `<div class="text">${textHtml(post)}</div>` : '',
    image: post.image
      ? `<img src="${escapeHtml(mediaPath(page.ref, post.image.url))}" alt="${escapeHtml(post.image.alt)}" loading="lazy">`
      : '',
    reactions: reactionsHtml(post, lang)
  })
}

export interface RenderOptions {
  /** The public address of this service. */
  publicUrl: string
  /** The address of Twake Chat, where « React in Twake Chat » opens the room. */
  chatUrl: string
  lang: 'en' | 'fr'
}

/** The HTML of a page, for people and for search engines. */
export function renderPage(
  page: Page,
  { publicUrl, chatUrl, lang }: RenderOptions
): string {
  const t = TEXTS[lang]
  const url = publicUrl + pagePath(page.ref)
  const image = page.coverUrl ?? page.avatarUrl
  const imageUrl = image ? publicUrl + mediaPath(page.ref, image) : null
  const description = page.topic.slice(0, DESCRIPTION_LIMIT)
  const posts = page.posts.map(post => postHtml(page, post, lang)).join('\n')
  const name = escapeHtml(page.name)
  return fill(PAGE, {
    lang,
    name,
    url: escapeHtml(url),
    description: escapeHtml(description),
    ogImage: imageUrl
      ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">`
      : '',
    twitterCard: imageUrl ? 'summary_large_image' : 'summary',
    structuredData: jsonForScript(
      structuredData(page, url, publicUrl, imageUrl)
    ),
    accent: page.accentColor,
    style: STYLE,
    cover: page.coverUrl
      ? `<img src="${escapeHtml(mediaPath(page.ref, page.coverUrl))}" alt="">`
      : '',
    avatar: page.avatarUrl
      ? `<img src="${escapeHtml(mediaPath(page.ref, page.avatarUrl))}" alt="">`
      : `<span class="avatar initials" role="img" aria-label="${name}">${escapeHtml(initialsOf(page.name))}</span>`,
    followers: `${String(page.followerCount)} ${page.followerCount === 1 ? t.follower : t.followers}`,
    topic: page.topic
      ? `<div class="topic">${sanitizeFormatted(markdown.render(page.topic))}</div>`
      : '',
    chatLink: escapeHtml(`${chatUrl}/rooms/${encodeURIComponent(page.roomId)}`),
    react: t.react,
    postsTitle: t.posts,
    posts: posts
      ? `<ul class="posts">\n${posts}\n</ul>`
      : `<p class="muted">${t.empty}</p>`
  })
}

export function renderSitemap(refs: string[], publicUrl: string): string {
  const urls = refs.map(
    ref => `  <url><loc>${escapeHtml(publicUrl + pagePath(ref))}</loc></url>`
  )
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`
}

/** Crawlers read the pages, never the API of the service (D398). */
export const renderRobots = (publicUrl: string): string =>
  `User-agent: *\nAllow: /b/\nAllow: /sitemap.xml\nDisallow: /\nSitemap: ${publicUrl}/sitemap.xml\n`
