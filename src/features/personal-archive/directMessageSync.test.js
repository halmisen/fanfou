/* eslint camelcase: off */

import syncDirectMessages from './directMessageSync'
import { createArchiveMeta, resumeOrStartSync } from './checkpoint'

jest.mock('./directMessageStore', () => jest.fn())

import createDirectMessageStore from './directMessageStore'

function conversation(otherid) {
  return { otherid, name: `name-${otherid}` }
}

function message(id) {
  return { id, created_at: 'Wed Aug 12 12:00:00 +0000 2026', text: `private-${id}` }
}

test('private-message resume points survive a timeline sync and another unfinished favorite run', async () => {
  const account = { id: 'me' }
  let meta = createArchiveMeta(account, '2026-08-13T00:00:00.000Z')
  const dmRun = {
    resource: 'directMessages', nextConversationId: 'a', nextMessagePage: 3, committedPages: 2,
  }
  meta.activeRun = dmRun
  meta = resumeOrStartSync(meta, account, '2026-08-13T00:00:00.000Z', 'statuses')
  const statusRun = meta.activeRun
  const favoriteRun = { resource: 'favorites', nextMaxId: 'favorite-cursor' }
  meta.pendingRuns.favorites = favoriteRun
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
  }
  const client = {
    fetchDirectMessageConversationList: jest.fn()
      .mockResolvedValueOnce([ conversation('a') ])
      .mockResolvedValueOnce([]),
    fetchDirectMessageConversation: jest.fn().mockResolvedValue([]),
  }
  createDirectMessageStore.mockReturnValue({})

  await syncDirectMessages({ account, client, store, sleep: () => Promise.resolve() })

  expect(client.fetchDirectMessageConversation).toHaveBeenCalledWith('a', { count: 60, page: 3 })
  expect(meta.activeRun).toBeNull()
  expect(meta.pendingRuns).toEqual({ statuses: statusRun, favorites: favoriteRun })
})

test('switching to private messages checks account ownership before changing any checkpoint', async () => {
  const meta = createArchiveMeta({ id: 'original-account' }, '2026-08-13T00:00:00.000Z')
  const store = { readMeta: jest.fn().mockResolvedValue(meta), writeMeta: jest.fn() }
  const client = { fetchDirectMessageConversationList: jest.fn() }

  await expect(syncDirectMessages({ account: { id: 'other-account' }, client, store }))
    .rejects.toThrow('当前授权账号')

  expect(store.writeMeta).not.toHaveBeenCalled()
  expect(client.fetchDirectMessageConversationList).not.toHaveBeenCalled()
  expect(meta.activeRun.resource).toBe('statuses')
})

test('direct-message sync commits each conversation page before its resume point advances', async () => {
  let meta = null
  const events = []
  const client = {
    fetchDirectMessageConversationList: jest.fn()
      .mockResolvedValueOnce([ conversation('a'), conversation('b') ])
      .mockResolvedValueOnce([]),
    fetchDirectMessageConversation: jest.fn()
      .mockResolvedValueOnce([ message('a1') ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ message('b1') ])
      .mockResolvedValueOnce([]),
  }
  createDirectMessageStore.mockReturnValue({
    commitConversationPage({ meta: pendingMeta, rawMessages }) {
      events.push(`commit:${rawMessages[0].id}:${pendingMeta.activeRun.nextConversationId}:${pendingMeta.activeRun.nextMessagePage}`)
      meta = {
        ...pendingMeta,
        counts: { directMessages: events.length },
        directMessages: { conversationCount: events.length },
      }
      return Promise.resolve({ meta })
    },
  })
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
  }

  const result = await syncDirectMessages({
    account: { id: 'me' }, client, store, sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-13T00:00:00.000Z'),
  })

  expect(events).toEqual([ 'commit:a1:a:2', 'commit:b1:b:2' ])
  expect(result.status).toBe('completed')
  expect(result.meta.activeRun).toBeNull()
  expect(result.meta.counts.directMessages).toBe(2)
})

test('a conversation-list error records only its safe error message and resume state', async () => {
  let meta = null
  const failure = new Error('request unavailable')
  createDirectMessageStore.mockReturnValue({})
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
  }

  await expect(syncDirectMessages({
    account: { id: 'me' },
    client: { fetchDirectMessageConversationList: () => Promise.reject(failure) },
    store,
    clock: () => new Date('2026-08-13T00:00:00.000Z'),
  })).rejects.toThrow('request unavailable')

  expect(meta.activeRun).toMatchObject({
    resource: 'directMessages',
    nextConversationId: null,
    stopReason: 'error',
    lastError: { message: 'request unavailable' },
  })
})

test('a transient private-message request retries before it advances the page', async () => {
  let meta = null
  const sleeps = []
  const retries = []
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
  }
  createDirectMessageStore.mockReturnValue({
    commitConversationPage({ meta: pendingMeta }) {
      meta = {
        ...pendingMeta,
        counts: { directMessages: 1 },
        directMessages: { conversationCount: 1 },
      }
      return Promise.resolve({ meta })
    },
  })
  const client = {
    fetchDirectMessageConversationList: jest.fn()
      .mockResolvedValueOnce([ conversation('a') ])
      .mockResolvedValueOnce([]),
    fetchDirectMessageConversation: jest.fn()
      .mockRejectedValueOnce(new Error('network interrupted'))
      .mockResolvedValueOnce([ message('a1') ])
      .mockResolvedValueOnce([]),
  }

  await syncDirectMessages({
    account: { id: 'me' }, client, store,
    sleep: delay => {
      sleeps.push(delay)
      return Promise.resolve()
    },
    onRetry: retry => retries.push(retry.stage),
  })

  expect(retries).toEqual([ 'conversation' ])
  expect(sleeps).toEqual([ 1000, 500 ])
  expect(client.fetchDirectMessageConversation).toHaveBeenCalledTimes(3)
})

test('a repeated private-message page fails instead of looping forever', async () => {
  let meta = null
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
  }
  createDirectMessageStore.mockReturnValue({
    commitConversationPage({ meta: pendingMeta }) {
      meta = {
        ...pendingMeta,
        counts: { directMessages: 1 },
        directMessages: { conversationCount: 1 },
      }
      return Promise.resolve({ meta })
    },
  })

  await expect(syncDirectMessages({
    account: { id: 'me' },
    client: {
      fetchDirectMessageConversationList: jest.fn()
        .mockResolvedValueOnce([ conversation('a') ])
        .mockResolvedValueOnce([]),
      fetchDirectMessageConversation: jest.fn()
        .mockResolvedValueOnce([ message('a1') ])
        .mockResolvedValueOnce([ message('a1') ]),
    },
    store,
    sleep: () => Promise.resolve(),
  })).rejects.toThrow('私信会话分页没有前进')

  expect(meta.activeRun).toMatchObject({ stopReason: 'error', nextConversationId: 'a', nextMessagePage: 2 })
})
