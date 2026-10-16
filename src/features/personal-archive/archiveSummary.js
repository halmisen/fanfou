/**
 * 首页侧栏入口与设置页面板之间唯一的共享状态。
 *
 * 为什么要单独存一份摘要，而不是让首页直接读 `meta.json`：
 * File System Access 的目录句柄按 origin 存放在 IndexedDB 里，设置页是
 * `chrome-extension://<id>`，饭否首页是 `https://fanfou.com`，两个 origin 拿不到对方的句柄。
 * 所以首页读不到磁盘，只能显示设置页同步完成后写进 chrome.storage 的这份摘要。
 */

export const SUMMARY_STORAGE_KEY = 'personal-archive/summary'
export const SUMMARY_STORAGE_AREA = 'local'

/**
 * 从 meta.json 提炼出首页要显示的最小字段。刻意不放路径与账号 id：
 * 侧栏是截图高发区，备份目录路径没必要出现在页面上。
 */
export function toSummary(meta, {
  directoryName = null,
  hasOfflinePages = false,
  isRunning = false,
  updatedAt = null,
} = {}) {
  if (!meta) return null

  return {
    statuses: meta.counts?.statuses || 0,
    lastSyncedAt: meta.lastSyncedAt || null,
    reachedFirstEver: Boolean(meta.watermark?.statuses?.reachedFirstEver),
    hasUnfinishedRun: Boolean(meta.activeRun || Object.keys(meta.pendingRuns || {}).length),
    isRunning,
    updatedAt,
    directoryName,
    hasOfflinePages,
    years: Object.keys(meta.shards?.statuses || {})
      .map(month => month.slice(0, 4))
      .filter(year => /^\d{4}$/.test(year))
      .filter((year, index, years) => years.indexOf(year) === index)
      .sort((a, b) => b.localeCompare(a)),
  }
}

// 备份标签页被关掉时不会再写一次摘要，isRunning 会永远停在 true。
// 超过这个时间没有新进度就不再声称「进行中」，宁可少说也不要说错。
export const RUNNING_SUMMARY_TTL_MS = 60 * 1000

function isRunningNow(summary, now) {
  if (!summary?.isRunning) return false
  if (!summary.updatedAt) return false

  const updatedAt = new Date(summary.updatedAt).getTime()
  if (Number.isNaN(updatedAt)) return false

  return now - updatedAt < RUNNING_SUMMARY_TTL_MS
}

function formatDate(isoString) {
  if (!isoString) return ''

  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''

  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 首页那一行字。措辞要能让人一眼判断「要不要现在去备份」，所以未完成的同步优先于条数显示。
 */
export function formatSummaryText(summary, now = Date.now()) {
  if (!summary) return '还没有备份过'

  // 正在跑的时候，进度比「上次备份到哪」重要得多。
  if (isRunningNow(summary, now)) {
    return `正在备份…已同步 ${summary.statuses} 条`
  }

  if (summary.hasUnfinishedRun) {
    return `已备份 ${summary.statuses} 条，还有未完成的同步`
  }

  const date = formatDate(summary.lastSyncedAt)
  if (!date) return `已备份 ${summary.statuses} 条`

  return `已备份 ${summary.statuses} 条 · ${date}`
}
