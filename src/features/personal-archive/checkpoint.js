import { ARCHIVE_TIMEZONE } from './statusRecords'

export function createArchiveMeta(account, now) {
  return {
    schemaVersion: 1,
    archiveTimezone: ARCHIVE_TIMEZONE,
    account: {
      id: account.id,
      name: account.name || account.screen_name || account.id,
    },
    lastSyncedAt: null,
    watermark: {
      statuses: {
        newestId: null,
        oldestId: null,
        nextMaxId: null,
        reachedFirstEver: false,
      },
    },
    activeRun: {
      resource: 'statuses',
      mode: 'backfill',
      nextMaxId: null,
      startedAt: now,
      committedPages: 0,
      stopReason: 'running',
      stoppedAt: null,
      lastError: null,
    },
    shards: { statuses: {} },
    counts: { statuses: 0 },
  }
}

/**
 * 记录这一轮为什么停下来。
 *
 * 没有这个字段时，「用户主动暂停」「报错中止」「标签页被回收」在磁盘上完全同形，
 * 用户重开面板只会看到同一句「检测到未完成同步」，无法自证。
 * 详见 tasks/card-archive-reliability.md 的 D3。
 */
export function markRunStopped(meta, { reason, message = null, now }) {
  if (!meta?.activeRun) return meta

  return {
    ...meta,
    activeRun: {
      ...meta.activeRun,
      stopReason: reason,
      stoppedAt: now,
      lastError: message ? { message, at: now } : null,
    },
  }
}

function emptyWatermark() {
  return {
    newestId: null,
    oldestId: null,
    nextMaxId: null,
    reachedFirstEver: false,
  }
}

function getResourceWatermark(meta, resource) {
  return meta.watermark?.[resource] || emptyWatermark()
}

// activeRun 是上次操作的任务，不代表它仍在执行。切换归档种类时保留完整断点，
// 尤其不能丢掉增量同步的 stopAnchorId，或私信的会话和页码。
export function selectArchiveRun(meta, resource) {
  if (!meta || meta.activeRun?.resource === resource) return meta
  if (!meta.activeRun && !meta.pendingRuns?.[resource]) return meta

  const pendingRuns = { ...(meta.pendingRuns || {}) }
  if (meta.activeRun) pendingRuns[meta.activeRun.resource] = meta.activeRun
  const activeRun = pendingRuns[resource] || null
  delete pendingRuns[resource]

  return { ...meta, activeRun, pendingRuns }
}

export function assertArchiveAccount(meta, account) {
  if (meta.account?.id !== account.id) {
    // 这句会原样显示给用户，所以写成能直接照做的中文。
    // 多账号用户最容易撞上：网页切了账号，但 OAuth 授权还是原来那个。
    const found = meta.account?.name || meta.account?.id || '未知账号'
    const current = account.name || account.id
    throw new Error(
      `这个文件夹是「${found}」的备份，当前授权账号是「${current}」。`
      + '换一个空文件夹备份当前账号，或先到「API 接入」重新授权回原来的账号。',
    )
  }
}

export function resumeOrStartSync(meta, account, now, resource = 'statuses') {
  if (!meta) {
    const initialMeta = createArchiveMeta(account, now)
    if (resource === 'statuses') return initialMeta

    return {
      ...initialMeta,
      watermark: { ...initialMeta.watermark, [resource]: emptyWatermark() },
      shards: { ...initialMeta.shards, [resource]: {} },
      counts: { ...initialMeta.counts, [resource]: 0 },
      activeRun: {
        ...initialMeta.activeRun,
        resource,
      },
    }
  }
  assertArchiveAccount(meta, account)
  const resourceMeta = {
    ...selectArchiveRun(meta, resource),
    watermark: {
      ...(meta.watermark || {}),
      [resource]: getResourceWatermark(meta, resource),
    },
    shards: {
      ...(meta.shards || {}),
      [resource]: meta.shards?.[resource] || {},
    },
    counts: {
      ...(meta.counts || {}),
      [resource]: meta.counts?.[resource] || 0,
    },
  }
  // 续传：上一轮的停止原因已经交代过了，这一轮重新开始计时。
  if (resourceMeta.activeRun) {
    return {
      ...resourceMeta,
      activeRun: {
        ...resourceMeta.activeRun,
        stopReason: 'running',
        stoppedAt: null,
        lastError: null,
      },
    }
  }

  const watermark = getResourceWatermark(resourceMeta, resource)
  const completedBackfill = watermark.reachedFirstEver
  if (completedBackfill) {
    return {
      ...resourceMeta,
      activeRun: {
        resource,
        mode: 'incremental',
        nextMaxId: null,
        stopAnchorId: watermark.newestId,
        startedAt: now,
        committedPages: 0,
        stopReason: 'running',
        stoppedAt: null,
        lastError: null,
      },
    }
  }

  return {
    ...resourceMeta,
    activeRun: {
      resource,
      mode: 'backfill',
      nextMaxId: watermark.nextMaxId,
      startedAt: now,
      committedPages: 0,
      stopReason: 'running',
      stoppedAt: null,
      lastError: null,
    },
  }
}

export function applyBackfillPage(meta, page, nextMaxId, now, resource = 'statuses') {
  const previousWatermark = getResourceWatermark(meta, resource)

  return {
    ...meta,
    watermark: {
      ...meta.watermark,
      [resource]: {
        ...previousWatermark,
        newestId: previousWatermark.newestId || page[0].id,
        oldestId: page[page.length - 1].id,
        nextMaxId,
        reachedFirstEver: false,
      },
    },
    activeRun: {
      ...meta.activeRun,
      nextMaxId,
      committedPages: (meta.activeRun?.committedPages || 0) + 1,
      lastCheckpointAt: now,
    },
  }
}

export function finishBackfill(meta, now, resource = 'statuses') {
  return {
    ...meta,
    lastSyncedAt: resource === 'statuses' ? now : meta.lastSyncedAt,
    lastSyncedAtByResource: {
      ...(meta.lastSyncedAtByResource || {}),
      [resource]: now,
    },
    watermark: {
      ...meta.watermark,
      [resource]: {
        ...getResourceWatermark(meta, resource),
        nextMaxId: null,
        reachedFirstEver: true,
      },
    },
    activeRun: null,
  }
}

export function applyIncrementalPage(meta, page, nextMaxId, now, completed, resource = 'statuses') {
  const previousWatermark = getResourceWatermark(meta, resource)
  const isFirstCommittedPage = (meta.activeRun?.committedPages || 0) === 0

  return {
    ...meta,
    lastSyncedAt: completed && resource === 'statuses' ? now : meta.lastSyncedAt,
    lastSyncedAtByResource: completed
      ? { ...(meta.lastSyncedAtByResource || {}), [resource]: now }
      : meta.lastSyncedAtByResource,
    watermark: {
      ...meta.watermark,
      [resource]: {
        ...previousWatermark,
        newestId: isFirstCommittedPage && page[0]?.id
          ? page[0].id
          : previousWatermark.newestId,
        nextMaxId: completed ? null : nextMaxId,
        reachedFirstEver: true,
      },
    },
    activeRun: completed
      ? null
      : {
        ...meta.activeRun,
        nextMaxId,
        committedPages: (meta.activeRun?.committedPages || 0) + 1,
        lastCheckpointAt: now,
      },
  }
}
