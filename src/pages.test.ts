import { describe, expect, it } from 'vitest'
import {
  canonicalRef,
  hasAllPosts,
  isCandidate,
  isPublic,
  mediaOf,
  parseMxc,
  parseRef,
  PUBLIC_PAGE_EVENT,
  readPage,
  sitemapRef
} from './pages.ts'
import type { RoomEvent } from './room-reader.ts'

const ROOM = '!room:example.org'
let count = 0

function event(
  type: string,
  content: Record<string, unknown>,
  extra: Partial<RoomEvent> = {}
): RoomEvent {
  count += 1
  return {
    type,
    content,
    sender: '@alice:example.org',
    event_id: `$e${String(count)}`,
    origin_server_ts: 1_700_000_000_000 + count,
    ...extra
  }
}

const state = (type: string, content: Record<string, unknown>, key = '') =>
  event(type, content, { state_key: key })

function openRoom(
  changes: Record<string, Record<string, unknown> | null> = {}
) {
  const contents: Record<string, Record<string, unknown> | null> = {
    'm.room.create': { room_version: '11' },
    'm.room.history_visibility': { history_visibility: 'world_readable' },
    'm.room.join_rules': { join_rule: 'public' },
    'm.room.name': { name: 'News' },
    [PUBLIC_PAGE_EVENT]: { enabled: true },
    ...changes
  }
  return [
    ...Object.entries(contents)
      .filter(([, content]) => content !== null)
      .map(([type, content]) => state(type, content ?? {})),
    state(
      'm.room.member',
      { membership: 'join', displayname: 'Alice' },
      '@alice:example.org'
    )
  ]
}

describe('isPublic', () => {
  it('opens a world readable room open to all whose owner turned the page on', () => {
    expect(isPublic(openRoom())).toBe(true)
  })

  it.each([
    [
      'history kept to members',
      { 'm.room.history_visibility': { history_visibility: 'shared' } }
    ],
    [
      'a room on invitation (D388)',
      { 'm.room.join_rules': { join_rule: 'invite' } }
    ],
    ['a page not turned on', { [PUBLIC_PAGE_EVENT]: { enabled: 'true' } }],
    ['no opt-in at all', { [PUBLIC_PAGE_EVENT]: null }],
    ['a space', { 'm.room.create': { type: 'm.space' } }],
    [
      'an encrypted room',
      { 'm.room.encryption': { algorithm: 'm.megolm.v1.aes-sha2' } }
    ]
  ])('refuses %s', (_, changes) => {
    expect(isPublic(openRoom(changes))).toBe(false)
  })
})

describe('the directory', () => {
  const listed = {
    room_id: ROOM,
    world_readable: true,
    join_rule: 'public',
    canonical_alias: '#news:example.org'
  }

  it('keeps the rooms open to all that anyone may read, spaces aside', () => {
    expect(isCandidate(listed)).toBe(true)
    expect(isCandidate({ ...listed, join_rule: 'invite' })).toBe(false)
    expect(isCandidate({ ...listed, world_readable: false })).toBe(false)
    expect(isCandidate({ ...listed, room_type: 'm.space' })).toBe(false)
  })

  it('names a room by its local slug, else by its id', () => {
    expect(sitemapRef(listed, 'example.org')).toBe('news')
    expect(sitemapRef(listed, 'other.org')).toBe(ROOM)
  })
})

describe('parseRef', () => {
  it('reads a slug as a local alias and a room id as itself', () => {
    expect(parseRef('news', 'example.org')).toEqual({
      alias: '#news:example.org'
    })
    expect(parseRef(ROOM, 'example.org')).toEqual({ roomId: ROOM })
    expect(parseRef('%21room%3Aexample.org', 'example.org')).toBeNull()
    expect(parseRef('../admin', 'example.org')).toBeNull()
  })
})

describe('canonicalRef', () => {
  it('reads a link encoded twice once more, and nothing else', () => {
    expect(canonicalRef('news')).toBe('news')
    // A link encoded twice, as the route gives it once decoded
    expect(canonicalRef('%21room%3Aexample.org')).toBe(ROOM)
    expect(canonicalRef('%6eews')).toBe('news')
    expect(canonicalRef('%2E%2E%2Fadmin')).toBeNull()
    expect(canonicalRef('%E0%A4%A')).toBeNull()
  })
})

describe('parseMxc', () => {
  it('reads a server name and a media id, and nothing that climbs the media path', () => {
    expect(parseMxc('mxc://example.org:8448/abc_D-1')).toEqual({
      server: 'example.org:8448',
      id: 'abc_D-1'
    })
    for (const url of [
      'mxc://../config',
      'mxc://./config',
      'mxc://example..org/abc',
      'mxc://example.org:/abc',
      'mxc://example.org/../abc'
    ]) {
      expect(parseMxc(url)).toBeNull()
    }
  })
})

describe('hasAllPosts', () => {
  it('counts the posts only, not the reactions nor the edits', () => {
    const post = event('m.room.message', { msgtype: 'm.text', body: 'Hi' })
    const reactions = Array.from({ length: 100 }, () =>
      event('m.reaction', {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: post.event_id,
          key: '👍'
        }
      })
    )

    expect(hasAllPosts([...reactions, post])).toBe(false)
    expect(hasAllPosts(Array.from({ length: 30 }, () => post))).toBe(true)
  })
})

describe('readPage', () => {
  it('shows nothing of a room that fails the gate', () => {
    expect(
      readPage('news', ROOM, openRoom({ [PUBLIC_PAGE_EVENT]: null }), [])
    ).toBeNull()
  })

  it('shows the posts newest first, edited by their sender only, with the reactions of members', () => {
    const post = event('m.room.message', { msgtype: 'm.text', body: 'first' })
    const thread = event('m.room.message', {
      body: 'in a thread',
      'm.relates_to': { rel_type: 'm.thread', event_id: post.event_id }
    })
    const edit = (sender: string, body: string) =>
      event(
        'm.room.message',
        {
          body: `* ${body}`,
          'm.new_content': { msgtype: 'm.text', body },
          'm.relates_to': { rel_type: 'm.replace', event_id: post.event_id }
        },
        { sender }
      )
    const react = (sender: string, key: string) =>
      event(
        'm.reaction',
        {
          'm.relates_to': {
            rel_type: 'm.annotation',
            event_id: post.event_id,
            key
          }
        },
        { sender }
      )
    const messages = [
      edit('@mallory:example.org', 'hijacked'),
      edit('@alice:example.org', 'first, edited'),
      react('@bob:example.org', '👍'),
      react('@bob:example.org', '👍'),
      react('@carol:example.org', '👍'),
      thread,
      post
    ]

    const page = readPage('news', ROOM, openRoom(), messages)

    expect(page?.roomId).toBe(ROOM)
    expect(page?.name).toBe('News')
    expect(page?.followerCount).toBe(1)
    expect(page?.posts).toEqual([
      {
        id: post.event_id,
        author: 'Alice',
        at: post.origin_server_ts,
        text: 'first, edited',
        formatted: null,
        image: null,
        reactions: { '👍': 2 }
      }
    ])
  })

  it('serves only the media the page shows', () => {
    const image = event('m.room.message', {
      msgtype: 'm.image',
      body: 'a cat',
      url: 'mxc://example.org/cat'
    })
    const page = readPage(
      'news',
      ROOM,
      openRoom({ 'm.room.avatar': { url: 'mxc://example.org/avatar' } }),
      [image]
    )

    expect(page && [...mediaOf(page)]).toEqual([
      'mxc://example.org/avatar',
      'mxc://example.org/cat'
    ])
  })
})
