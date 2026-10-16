/* eslint camelcase: off */

import syncOwnTimeline, { syncStatusStream } from './sync'
import { createArchiveMeta, finishBackfill } from './checkpoint'

function rawStatus(id, createdAt) {
  return {
    id,
    created_at: createdAt,
    text: `status ${id}`,
    user: { id: 'me', screen_name: 'me', name: 'Me' },
  }
}

test('new messages sync while an unfinished favorite backup retains its disk checkpoint for later resume', async () => {
  const account = { id: 'me', name: 'Me' }
  const now = '2026-08-13T00:00:00.000Z'
  let diskMeta = finishBackfill(createArchiveMeta(account, now), now)
  diskMeta.watermark.statuses.newestId = 'old-message'
  const favoriteRun = { resource: 'favorites', mode: 'backfill', nextMaxId: 'saved-favorite', committedPages: 2 }
  diskMeta.activeRun = favoriteRun
  const store = {
    readMeta: () => Promise.resolve(JSON.parse(JSON.stringify(diskMeta))),
    writeMeta(value) {
      diskMeta = JSON.parse(JSON.stringify(value))
      return Promise.resolve()
    },
    commitStatusPage: jest.fn(({ meta, statuses }) => {
      diskMeta = { ...meta, counts: { ...meta.counts, statuses: statuses.length } }
      return Promise.resolve(diskMeta)
    }),
  }
  const timeline = jest.fn().mockResolvedValue([
    rawStatus('new-message', 'Wed Aug 12 12:00:00 +0000 2026'),
    rawStatus('old-message', 'Wed Aug 12 11:00:00 +0000 2026'),
  ])

  await syncOwnTimeline({ account, store, fetchPage: timeline })

  expect(diskMeta.activeRun).toBeNull()
  expect(diskMeta.pendingRuns.favorites).toEqual(favoriteRun)
  expect(diskMeta.watermark.statuses.newestId).toBe('new-message')
  expect(store.commitStatusPage.mock.calls[0][0].statuses.map(status => status.id)).toEqual([ 'new-message' ])

  const favorites = jest.fn().mockResolvedValue([])
  await syncStatusStream({ account, store, resource: 'favorites', archiveSource: 'favorite', fetchPage: favorites })

  expect(favorites).toHaveBeenCalledWith({ count: 60, max_id: 'saved-favorite' })
  expect(diskMeta.activeRun).toBeNull()
  expect(diskMeta.pendingRuns.favorites).toBeUndefined()
})

test('initial backfill commits each page before advancing an exclusive max_id cursor', async () => {
  const events = []
  const pages = [
    [
      rawStatus('3', 'Fri Jul 31 12:00:00 +0000 2026'),
      rawStatus('2', 'Thu Jul 30 12:00:00 +0000 2026'),
    ],
    [
      rawStatus('1', 'Wed Jul 29 12:00:00 +0000 2026'),
    ],
    [],
  ]
  let meta = null
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      events.push(`write-meta:${value.watermark.statuses.reachedFirstEver}`)
      return Promise.resolve()
    },
    commitStatusPage({ statuses, meta: nextMeta }) {
      meta = nextMeta
      events.push(`commit:${statuses.map(item => item.id).join(',')}:${nextMeta.watermark.statuses.nextMaxId}`)
      return Promise.resolve(nextMeta)
    },
  }
  const fetchPage = options => {
    events.push(`fetch:${options.max_id || 'top'}`)
    return Promise.resolve(pages.shift())
  }
  const sleep = milliseconds => {
    events.push(`sleep:${milliseconds}`)
    return Promise.resolve()
  }

  const result = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage,
    store,
    sleep,
    clock: () => new Date('2026-07-31T13:00:00.000Z'),
  })

  expect(events).toEqual([
    'write-meta:false',
    'fetch:top',
    'commit:3,2:2',
    'sleep:500',
    'fetch:2',
    'commit:1:1',
    'sleep:500',
    'fetch:1',
    'write-meta:true',
  ])
  expect(result.status).toBe('completed')
  expect(result.meta.activeRun).toBeNull()
  expect(result.meta.watermark.statuses).toEqual({
    newestId: '3',
    oldestId: '1',
    nextMaxId: null,
    reachedFirstEver: true,
  })
})

test('a one-item terminal echo of the saved cursor completes a backfill without recommitting it', async () => {
  const commits = []
  let meta = {
    schemaVersion: 1,
    archiveTimezone: 'Asia/Shanghai',
    account: { id: 'me', name: 'Me' },
    lastSyncedAt: null,
    watermark: {
      statuses: {
        newestId: '3',
        oldestId: '1',
        nextMaxId: '1',
        reachedFirstEver: false,
      },
    },
    activeRun: {
      resource: 'statuses',
      mode: 'backfill',
      nextMaxId: '1',
      startedAt: '2026-08-13T00:00:00.000Z',
      committedPages: 1,
      stopReason: 'error',
      stoppedAt: '2026-08-13T00:01:00.000Z',
      lastError: { message: 'Timeline pagination did not advance' },
    },
    shards: { statuses: {} },
    counts: { statuses: 3 },
  }
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage({ statuses, meta: nextMeta }) {
      commits.push(statuses)
      meta = nextMeta
      return Promise.resolve(nextMeta)
    },
  }

  const result = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.resolve([ rawStatus('1', 'Wed Jul 29 12:00:00 +0000 2026') ]),
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-13T00:02:00.000Z'),
  })

  expect(commits).toEqual([])
  expect(result.status).toBe('completed')
  expect(result.meta.activeRun).toBeNull()
  expect(result.meta.watermark.statuses).toEqual({
    newestId: '3',
    oldestId: '1',
    nextMaxId: null,
    reachedFirstEver: true,
  })
})

test('a multi-item page that does not advance the saved cursor remains an error', async () => {
  let meta = {
    schemaVersion: 1,
    archiveTimezone: 'Asia/Shanghai',
    account: { id: 'me', name: 'Me' },
    lastSyncedAt: null,
    watermark: {
      statuses: {
        newestId: '3',
        oldestId: '1',
        nextMaxId: '1',
        reachedFirstEver: false,
      },
    },
    activeRun: {
      resource: 'statuses',
      mode: 'backfill',
      nextMaxId: '1',
      startedAt: '2026-08-13T00:00:00.000Z',
      committedPages: 1,
      stopReason: 'error',
      stoppedAt: '2026-08-13T00:01:00.000Z',
      lastError: { message: 'Timeline pagination did not advance' },
    },
    shards: { statuses: {} },
    counts: { statuses: 3 },
  }
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage: () => Promise.reject(new Error('must not commit')),
  }

  await expect(syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.resolve([
      rawStatus('2', 'Thu Jul 30 12:00:00 +0000 2026'),
      rawStatus('1', 'Wed Jul 29 12:00:00 +0000 2026'),
    ]),
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-13T00:02:00.000Z'),
  })).rejects.toThrow('Timeline pagination did not advance')

  expect(meta.activeRun).toMatchObject({
    nextMaxId: '1',
    stopReason: 'error',
    lastError: { message: 'Timeline pagination did not advance' },
  })
})

test('a mention stream keeps its own cursor and commits into mentions', async () => {
  let meta = {
    schemaVersion: 1,
    archiveTimezone: 'Asia/Shanghai',
    account: { id: 'me', name: 'Me' },
    lastSyncedAt: '2026-07-30T13:00:00.000Z',
    watermark: {
      statuses: {
        newestId: '3',
        oldestId: '1',
        nextMaxId: null,
        reachedFirstEver: true,
      },
    },
    activeRun: null,
    shards: { statuses: {} },
    counts: { statuses: 3 },
  }
  const resources = []
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage({ resource, meta: nextMeta }) {
      resources.push(resource)
      meta = nextMeta
      return Promise.resolve(nextMeta)
    },
  }
  const pages = [
    [ rawStatus('m2', 'Fri Jul 31 12:00:00 +0000 2026') ],
    [],
  ]

  const result = await syncStatusStream({
    resource: 'mentions',
    archiveSource: 'mention',
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.resolve(pages.shift()),
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })

  expect(resources).toEqual([ 'mentions' ])
  expect(result.meta.watermark.statuses.newestId).toBe('3')
  expect(result.meta.watermark.mentions).toEqual({
    newestId: 'm2',
    oldestId: 'm2',
    nextMaxId: null,
    reachedFirstEver: true,
  })
  expect(result.meta.counts.mentions).toBe(0)
  expect(result.meta.lastSyncedAt).toBe('2026-07-30T13:00:00.000Z')
  expect(result.meta.lastSyncedAtByResource.mentions).toBe('2026-08-02T13:00:00.000Z')
})

test('a completed archive stops incremental sync at the previous newest status', async () => {
  const events = []
  let meta = {
    schemaVersion: 1,
    archiveTimezone: 'Asia/Shanghai',
    account: { id: 'me', name: 'Me' },
    lastSyncedAt: '2026-07-30T13:00:00.000Z',
    watermark: {
      statuses: {
        newestId: '3',
        oldestId: '1',
        nextMaxId: null,
        reachedFirstEver: true,
      },
    },
    activeRun: null,
    shards: {
      statuses: {
        '2026-07': { count: 3, newestId: '3', oldestId: '1' },
      },
    },
    counts: { statuses: 3 },
  }
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      events.push(`write-meta:${value.activeRun?.mode || 'finished'}`)
      return Promise.resolve()
    },
    commitStatusPage({ statuses, meta: nextMeta }) {
      meta = nextMeta
      events.push(`commit:${statuses.map(item => item.id).join(',')}`)
      return Promise.resolve(nextMeta)
    },
  }
  const fetchPage = options => {
    events.push(`fetch:${options.max_id || 'top'}`)
    return Promise.resolve([
      rawStatus('5', 'Sun Aug 02 12:00:00 +0000 2026'),
      rawStatus('4', 'Sat Aug 01 12:00:00 +0000 2026'),
      rawStatus('3', 'Fri Jul 31 12:00:00 +0000 2026'),
      rawStatus('2', 'Thu Jul 30 12:00:00 +0000 2026'),
    ])
  }

  const result = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage,
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })

  expect(events).toEqual([
    'write-meta:incremental',
    'fetch:top',
    'commit:5,4',
  ])
  expect(result.status).toBe('completed')
  expect(result.meta.activeRun).toBeNull()
  expect(result.meta.watermark.statuses).toEqual({
    newestId: '5',
    oldestId: '1',
    nextMaxId: null,
    reachedFirstEver: true,
  })
})

test('incremental sync keeps the first new id when the stop anchor is on a later page', async () => {
  let meta = {
    schemaVersion: 1,
    archiveTimezone: 'Asia/Shanghai',
    account: { id: 'me', name: 'Me' },
    lastSyncedAt: '2026-07-30T13:00:00.000Z',
    watermark: {
      statuses: {
        newestId: '1',
        oldestId: '0',
        nextMaxId: null,
        reachedFirstEver: true,
      },
    },
    activeRun: null,
    shards: { statuses: {} },
    counts: { statuses: 2 },
  }
  const pages = [
    [
      rawStatus('5', 'Sun Aug 02 12:00:00 +0000 2026'),
      rawStatus('4', 'Sat Aug 01 12:00:00 +0000 2026'),
    ],
    [
      rawStatus('3', 'Fri Jul 31 12:00:00 +0000 2026'),
      rawStatus('2', 'Thu Jul 30 12:00:00 +0000 2026'),
      rawStatus('1', 'Wed Jul 29 12:00:00 +0000 2026'),
    ],
  ]
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage({ meta: nextMeta }) {
      meta = nextMeta
      return Promise.resolve(nextMeta)
    },
  }

  const result = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.resolve(pages.shift()),
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })

  expect(result.meta.watermark.statuses.newestId).toBe('5')
})

test('an API failure preserves the last committed cursor for a later retry', async () => {
  let meta = null
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage({ meta: nextMeta }) {
      meta = nextMeta
      return Promise.resolve(nextMeta)
    },
  }

  await expect(syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.reject(new Error('network interrupted')),
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })).rejects.toThrow('network interrupted')

  expect(meta.activeRun).toMatchObject({
    mode: 'backfill',
    nextMaxId: null,
    committedPages: 0,
  })
  expect(meta.watermark.statuses.nextMaxId).toBeNull()
})

test('a malformed API item cannot be skipped while its page cursor advances', async () => {
  let meta = null
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage: () => Promise.reject(new Error('must not commit')),
  }

  await expect(syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.resolve([
      rawStatus('2', 'Fri Jul 31 12:00:00 +0000 2026'),
      { created_at: 'Thu Jul 30 12:00:00 +0000 2026', text: 'missing id' },
      rawStatus('1', 'Wed Jul 29 12:00:00 +0000 2026'),
    ]),
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })).rejects.toThrow('Timeline status is missing an id')

  expect(meta.activeRun.nextMaxId).toBeNull()
  expect(meta.watermark.statuses.nextMaxId).toBeNull()
})

test('a transient connection failure retries the same page instead of ending the run', async () => {
  const queries = []
  const retries = []
  const pages = [
    [ rawStatus('2', 'Fri Jul 31 12:00:00 +0000 2026') ],
    [],
  ]
  let meta = null
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage({ meta: nextMeta }) {
      meta = nextMeta
      return Promise.resolve(nextMeta)
    },
  }
  // Service Worker 空闲回收时 messaging 抛出的正是这个错误，端口随后自动重连。
  let failuresLeft = 2
  const fetchPage = query => {
    queries.push(query)
    if (failuresLeft > 0) {
      failuresLeft -= 1
      return Promise.reject(new Error('Port disconnected during Service Worker sleep'))
    }
    return Promise.resolve(pages.shift())
  }

  const result = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage,
    store,
    sleep: () => Promise.resolve(),
    onRetry: event => retries.push(`${event.stage}:${event.attempt}:${event.delay}`),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })

  expect(retries).toEqual([ 'fetch:1:1000', 'fetch:2:2000' ])
  expect(queries).toEqual([
    { count: 60 },
    { count: 60 },
    { count: 60 },
    { count: 60, max_id: '2' },
  ])
  expect(result.status).toBe('completed')
  expect(result.meta.counts).toBeDefined()
})

test('exhausted retries record the stop reason on disk and keep the cursor intact', async () => {
  let meta = null
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage({ meta: nextMeta }) {
      meta = nextMeta
      return Promise.resolve(nextMeta)
    },
  }

  await expect(syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.reject(new Error('Failed to fetch')),
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })).rejects.toThrow('Failed to fetch')

  expect(meta.activeRun).toMatchObject({
    mode: 'backfill',
    nextMaxId: null,
    committedPages: 0,
    stopReason: 'error',
    stoppedAt: '2026-08-02T13:00:00.000Z',
    lastError: { message: 'Failed to fetch', at: '2026-08-02T13:00:00.000Z' },
  })
  expect(meta.watermark.statuses.nextMaxId).toBeNull()
})

test('an authorization failure ends the run immediately instead of retrying', async () => {
  const attempts = []
  let meta = null
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage: () => Promise.reject(new Error('must not commit')),
  }

  await expect(syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => {
      attempts.push(1)
      const error = new Error('尚未完成授权，请先点击「开始授权」')
      error.status = 401
      return Promise.reject(error)
    },
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })).rejects.toThrow('尚未完成授权')

  expect(attempts).toHaveLength(1)
  expect(meta.activeRun.stopReason).toBe('error')
})

test('a server-side failure is retried but a client-side one is not', async () => {
  const statuses = []
  const run = status => {
    let meta = null
    const store = {
      readMeta: () => Promise.resolve(meta),
      writeMeta(value) {
        meta = value
        return Promise.resolve()
      },
      commitStatusPage: () => Promise.reject(new Error('must not commit')),
    }

    return syncOwnTimeline({
      account: { id: 'me', name: 'Me' },
      fetchPage: () => {
        statuses.push(status)
        const error = new Error(`Fanfou API ${status}`)
        error.status = status
        return Promise.reject(error)
      },
      store,
      sleep: () => Promise.resolve(),
      clock: () => new Date('2026-08-02T13:00:00.000Z'),
    })
  }

  await expect(run(503)).rejects.toThrow('Fanfou API 503')
  expect(statuses.filter(item => item === 503)).toHaveLength(5)

  await expect(run(400)).rejects.toThrow('Fanfou API 400')
  expect(statuses.filter(item => item === 400)).toHaveLength(1)
})

test('a temporarily locked shard file is retried but a revoked permission is not', async () => {
  const run = errorName => {
    let meta = null
    let commitAttempts = 0
    const store = {
      readMeta: () => Promise.resolve(meta),
      writeMeta(value) {
        meta = value
        return Promise.resolve()
      },
      commitStatusPage() {
        commitAttempts += 1
        const error = new Error(`write failed: ${errorName}`)
        error.name = errorName
        return Promise.reject(error)
      },
    }

    const promise = syncOwnTimeline({
      account: { id: 'me', name: 'Me' },
      fetchPage: () => Promise.resolve([ rawStatus('2', 'Fri Jul 31 12:00:00 +0000 2026') ]),
      store,
      sleep: () => Promise.resolve(),
      clock: () => new Date('2026-08-02T13:00:00.000Z'),
    })

    return { promise, getAttempts: () => commitAttempts, getMeta: () => meta }
  }

  const locked = run('NoModificationAllowedError')
  await expect(locked.promise).rejects.toThrow('NoModificationAllowedError')
  expect(locked.getAttempts()).toBe(5)

  const denied = run('NotAllowedError')
  await expect(denied.promise).rejects.toThrow('NotAllowedError')
  expect(denied.getAttempts()).toBe(1)
  expect(denied.getMeta().activeRun.lastError.message).toBe('write failed: NotAllowedError')
})

test('a pause records why the run stopped so it can be told apart from a crash', async () => {
  let meta = null
  let committedPages = 0
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage({ meta: nextMeta }) {
      meta = nextMeta
      committedPages += 1
      return Promise.resolve(nextMeta)
    },
  }

  const result = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.resolve([
      rawStatus('3', 'Fri Jul 31 12:00:00 +0000 2026'),
      rawStatus('2', 'Thu Jul 30 12:00:00 +0000 2026'),
    ]),
    store,
    sleep: () => Promise.resolve(),
    shouldPause: () => committedPages === 1,
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })

  expect(result.status).toBe('paused')
  expect(meta.activeRun).toMatchObject({
    stopReason: 'paused',
    stoppedAt: '2026-08-02T13:00:00.000Z',
    lastError: null,
    nextMaxId: '2',
  })
})

test('resuming a stopped run clears the previous stop reason', async () => {
  let meta = {
    schemaVersion: 1,
    archiveTimezone: 'Asia/Shanghai',
    account: { id: 'me', name: 'Me' },
    lastSyncedAt: null,
    watermark: {
      statuses: { newestId: '3', oldestId: '2', nextMaxId: '2', reachedFirstEver: false },
    },
    activeRun: {
      resource: 'statuses',
      mode: 'backfill',
      nextMaxId: '2',
      startedAt: '2026-08-01T13:00:00.000Z',
      committedPages: 1,
      stopReason: 'error',
      stoppedAt: '2026-08-01T13:05:00.000Z',
      lastError: { message: 'Failed to fetch', at: '2026-08-01T13:05:00.000Z' },
    },
    shards: { statuses: {} },
    counts: { statuses: 2 },
  }
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage: () => Promise.reject(new Error('must not commit')),
  }

  const result = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage: () => Promise.resolve([]),
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })

  expect(result.status).toBe('completed')
  expect(result.meta.activeRun).toBeNull()
  expect(result.meta.watermark.statuses.reachedFirstEver).toBe(true)
})

test('a paused run resumes from the last page that was committed to disk', async () => {
  let meta = null
  let committedPages = 0
  const queries = []
  const store = {
    readMeta: () => Promise.resolve(meta),
    writeMeta(value) {
      meta = value
      return Promise.resolve()
    },
    commitStatusPage({ meta: nextMeta }) {
      meta = nextMeta
      committedPages += 1
      return Promise.resolve(nextMeta)
    },
  }

  const paused = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage(query) {
      queries.push(query)
      return Promise.resolve([
        rawStatus('3', 'Fri Jul 31 12:00:00 +0000 2026'),
        rawStatus('2', 'Thu Jul 30 12:00:00 +0000 2026'),
      ])
    },
    store,
    sleep: () => Promise.resolve(),
    shouldPause: () => committedPages === 1,
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
  })

  expect(paused.status).toBe('paused')
  expect(meta.activeRun.nextMaxId).toBe('2')

  const resumed = await syncOwnTimeline({
    account: { id: 'me', name: 'Me' },
    fetchPage(query) {
      queries.push(query)
      return Promise.resolve([])
    },
    store,
    sleep: () => Promise.resolve(),
    clock: () => new Date('2026-08-02T13:01:00.000Z'),
  })

  expect(queries).toEqual([
    { count: 60 },
    { count: 60, max_id: '2' },
  ])
  expect(resumed.status).toBe('completed')
})
