import { createArchiveMeta, resumeOrStartSync, finishBackfill } from './checkpoint'

const account = { id: 'test-account', name: '测试账号' }
const now = '2026-10-14T00:00:00.000Z'

test.each([ 'statuses', 'mentions', 'favorites' ])('an unfinished favorite backup does not block %s', resource => {
  const initial = createArchiveMeta(account, now)
  const favoriteRun = { resource: 'favorites', mode: 'backfill', nextMaxId: 'favorite-cursor', committedPages: 2 }
  initial.activeRun = favoriteRun

  const switched = resumeOrStartSync(initial, account, now, resource)

  expect(switched.activeRun.resource).toBe(resource)
  if (resource !== 'favorites') {
    expect(switched.pendingRuns.favorites).toEqual(favoriteRun)
    const completed = finishBackfill(switched, now, resource)
    const resumed = resumeOrStartSync(completed, account, now, 'favorites')
    expect(resumed.activeRun).toMatchObject(favoriteRun)
    expect(resumed.pendingRuns.favorites).toBeUndefined()
  }
  expect(initial.activeRun).toBe(favoriteRun)
})

test('switching away from an incremental run retains its original stop anchor and cursor', () => {
  const initial = createArchiveMeta(account, now)
  const statusRun = {
    resource: 'statuses', mode: 'incremental', nextMaxId: 'page-two',
    stopAnchorId: 'original-newest', committedPages: 1,
    stopReason: 'error', lastError: { message: 'network' },
  }
  initial.activeRun = statusRun
  initial.watermark.statuses.newestId = 'newly-committed'

  const switched = resumeOrStartSync(initial, account, now, 'mentions')
  const resumed = resumeOrStartSync(switched, account, now, 'statuses')

  expect(resumed.activeRun).toMatchObject({
    resource: 'statuses', mode: 'incremental', nextMaxId: 'page-two',
    stopAnchorId: 'original-newest', committedPages: 1,
    stopReason: 'running', lastError: null,
  })
  expect(resumed.pendingRuns.mentions.resource).toBe('mentions')
  expect(resumed.pendingRuns.statuses).toBeUndefined()
})
