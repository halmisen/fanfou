import { toSummary, formatSummaryText, RUNNING_SUMMARY_TTL_MS } from './archiveSummary'

const META = {
  counts: { statuses: 23281 },
  lastSyncedAt: '2026-07-31T07:40:00.000Z',
  watermark: { statuses: { reachedFirstEver: true, oldestId: 'abc' } },
}

describe('toSummary', () => {
  test('没有 meta 时返回 null，首页据此显示「还没有备份过」', () => {
    expect(toSummary(null)).toBeNull()
    expect(toSummary(undefined)).toBeNull()
  })

  test('只提取首页要用的字段', () => {
    expect(toSummary(META, { directoryName: '饭否备份' })).toEqual({
      statuses: 23281,
      lastSyncedAt: '2026-07-31T07:40:00.000Z',
      reachedFirstEver: true,
      hasUnfinishedRun: false,
      isRunning: false,
      updatedAt: null,
      directoryName: '饭否备份',
      hasOfflinePages: false,
      years: [],
    })
  })

  test('不泄漏 meta 里的其它字段（备份目录路径、账号信息等不进侧栏）', () => {
    const summary = toSummary({
      ...META,
      account: { id: 'someone', name: '某人' },
      directoryPath: '/home/someone/Documents',
    })

    expect(Object.keys(summary).sort()).toEqual([
      'directoryName',
      'hasOfflinePages',
      'hasUnfinishedRun',
      'isRunning',
      'lastSyncedAt',
      'reachedFirstEver',
      'statuses',
      'updatedAt',
      'years',
    ])
  })

  test('存在未完成的同步时置位 hasUnfinishedRun', () => {
    const summary = toSummary({ ...META, activeRun: { nextMaxId: 'x' } })

    expect(summary.hasUnfinishedRun).toBe(true)
  })

  test('当前同步完成后仍显示暂存的收藏任务', () => {
    const summary = toSummary({ ...META, activeRun: null, pendingRuns: { favorites: { resource: 'favorites' } } })

    expect(summary.hasUnfinishedRun).toBe(true)
    expect(formatSummaryText(summary)).toBe('已备份 23281 条，还有未完成的同步')
  })

  test('计数缺失时归零而不是 undefined', () => {
    expect(toSummary({}).statuses).toBe(0)
  })
})

describe('formatSummaryText', () => {
  test('没有摘要时提示还没备份过', () => {
    expect(formatSummaryText(null)).toBe('还没有备份过')
  })

  test('未完成的同步优先于日期显示', () => {
    const text = formatSummaryText(toSummary({ ...META, activeRun: {} }))

    expect(text).toBe('已备份 23281 条，还有未完成的同步')
  })

  test('正常情况显示条数与日期', () => {
    const text = formatSummaryText({
      statuses: 1483,
      lastSyncedAt: '2026-07-31T07:40:00.000Z',
      hasUnfinishedRun: false,
    })

    expect(text).toMatch(/^已备份 1483 条 · 2026-07-3[01]$/)
  })

  test('同步进行中时首页显示实时进度，优先于「有未完成的同步」', () => {
    const now = Date.parse('2026-08-11T02:00:00.000Z')
    const summary = toSummary({ ...META, activeRun: {}, counts: { statuses: 5700 } }, {
      isRunning: true,
      updatedAt: '2026-08-11T01:59:58.000Z',
    })

    expect(formatSummaryText(summary, now)).toBe('正在备份…已同步 5700 条')
  })

  test('进度停止刷新超过 TTL 后不再声称进行中——备份标签页可能已经被关掉', () => {
    const updatedAt = '2026-08-11T01:59:58.000Z'
    const stale = Date.parse(updatedAt) + RUNNING_SUMMARY_TTL_MS + 1
    const summary = toSummary({ ...META, activeRun: {}, counts: { statuses: 5700 } }, {
      isRunning: true,
      updatedAt,
    })

    expect(formatSummaryText(summary, stale)).toBe('已备份 5700 条，还有未完成的同步')
  })

  test('缺少 updatedAt 的运行态不被采信', () => {
    const summary = toSummary({ ...META, activeRun: {}, counts: { statuses: 5700 } }, {
      isRunning: true,
    })

    expect(formatSummaryText(summary, Date.now())).toBe('已备份 5700 条，还有未完成的同步')
  })

  test('时间戳不可解析时退回只显示条数', () => {
    expect(formatSummaryText({ statuses: 10, lastSyncedAt: '不是时间' }))
      .toBe('已备份 10 条')
    expect(formatSummaryText({ statuses: 10, lastSyncedAt: null }))
      .toBe('已备份 10 条')
  })
})
