import createDirectMessageStore from './directMessageStore'
import { getConversationUserId } from './directMessageRecords'
import { assertArchiveAccount, createArchiveMeta, selectArchiveRun } from './checkpoint'

const PAGE_SIZE = 60
const REQUEST_INTERVAL_MS = 500
const MAX_ATTEMPTS = 5
const RETRY_BASE_DELAY_MS = 1000
const RETRYABLE_MESSAGE_PATTERN = /Port disconnected|Port not initialized|Failed to fetch|NetworkError|network|请求超时/i
const RETRYABLE_ERROR_NAMES = new Set([ 'NoModificationAllowedError', 'InvalidStateError' ])

const sleepDefault = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function startRun(initialMeta, account, now) {
  const archiveMeta = initialMeta || { ...createArchiveMeta(account, now), activeRun: null }
  assertArchiveAccount(archiveMeta, account)
  const meta = selectArchiveRun(archiveMeta, 'directMessages')
  if (meta?.activeRun?.resource === 'directMessages') {
    const activeRun = { ...meta.activeRun }
    delete activeRun.stopReason
    delete activeRun.stoppedAt
    delete activeRun.lastError
    return { ...meta, activeRun }
  }

  return {
    ...(meta || {}),
    activeRun: {
      resource: 'directMessages',
      mode: 'backfill',
      committedPages: 0,
      nextConversationId: null,
      nextMessagePage: 1,
      startedAt: now,
    },
  }
}

function isRetryable(error) {
  if (RETRYABLE_ERROR_NAMES.has(error?.name)) return true
  if (error?.status === 429) return true
  if (error?.status >= 500 && error.status < 600) return true
  if (error?.status) return false
  return RETRYABLE_MESSAGE_PATTERN.test(error?.message || '')
}

async function withRetry(operation, { sleep, onRetry, stage }) {
  let attempt = 0
  while (true) {
    try {
      return await operation()
    } catch (error) {
      attempt += 1
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error
      const delay = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1))
      onRetry({ stage, attempt, maxAttempts: MAX_ATTEMPTS, delay, error })
      await sleep(delay)
    }
  }
}

function stopRun(meta, reason, now, message = '') {
  return {
    ...meta,
    activeRun: {
      ...meta.activeRun,
      stopReason: reason,
      stoppedAt: now,
      lastError: message ? { message } : null,
    },
  }
}

function finishRun(meta, now) {
  return {
    ...meta,
    activeRun: null,
    lastSyncedAtByResource: { ...(meta.lastSyncedAtByResource || {}), directMessages: now },
  }
}

async function fetchConversationList(client, { shouldPause, sleep, onRetry }) {
  const conversations = []
  const seen = new Set()

  for (let page = 1; page <= 200; page += 1) {
    if (shouldPause()) return null
    const items = await withRetry(
      () => client.fetchDirectMessageConversationList({ count: PAGE_SIZE, page }),
      { sleep, onRetry, stage: 'conversation-list' },
    )
    if (!items.length) return conversations

    let newCount = 0
    for (const item of items) {
      const id = getConversationUserId(item)
      if (!id) throw new TypeError('私信对话列表缺少 otherid')
      if (!seen.has(id)) {
        seen.add(id)
        conversations.push(item)
        newCount += 1
      }
    }
    if (!newCount) throw new Error('私信对话列表分页没有前进')
  }

  throw new Error('私信对话列表超过 200 页，已安全停止')
}

/**
 * 对话逐个、页面逐页提交。重跑只会按消息 ID 合并，绝不重复写入。
 * 私信正文不会出现在 progress 或错误文本里。
 */
export default async function syncDirectMessages({
  account,
  client,
  store,
  sleep = sleepDefault,
  clock = () => new Date(),
  shouldPause = () => false,
  onProgress = () => undefined,
  onRetry = () => undefined,
}) {
  const dmStore = createDirectMessageStore(store)
  let meta = startRun(await store.readMeta(), account, clock().toISOString())
  await store.writeMeta(meta)

  try {
    const conversations = await fetchConversationList(client, { shouldPause, sleep, onRetry })
    if (!conversations) {
      meta = stopRun(meta, 'paused', clock().toISOString())
      await store.writeMeta(meta)
      return { status: 'paused', meta }
    }
    const resumeId = meta.activeRun.nextConversationId
    let resumeFound = !resumeId

    for (const conversation of conversations) {
      const otherUserId = getConversationUserId(conversation)
      if (!resumeFound) {
        if (otherUserId !== resumeId) continue
        resumeFound = true
      }
      let pageNumber = otherUserId === resumeId ? meta.activeRun.nextMessagePage || 1 : 1
      const seenMessageIds = new Set()

      while (pageNumber <= 200) {
        if (shouldPause()) {
          meta = stopRun(meta, 'paused', clock().toISOString())
          await store.writeMeta(meta)
          return { status: 'paused', meta }
        }

        const conversationQuery = { count: PAGE_SIZE, page: pageNumber }
        const fetchConversation = () => client.fetchDirectMessageConversation(otherUserId, conversationQuery)
        const rawMessages = await withRetry(
          fetchConversation,
          { sleep, onRetry, stage: 'conversation' },
        )
        if (!rawMessages.length) break
        if (rawMessages.some(message => !message?.id)) throw new TypeError('私信缺少消息 ID')
        const newMessages = rawMessages.filter(message => !seenMessageIds.has(String(message.id)))
        if (!newMessages.length) throw new Error('私信会话分页没有前进')
        newMessages.forEach(message => seenMessageIds.add(String(message.id)))

        const pendingMeta = {
          ...meta,
          activeRun: {
            ...meta.activeRun,
            committedPages: (meta.activeRun.committedPages || 0) + 1,
            nextConversationId: otherUserId,
            nextMessagePage: pageNumber + 1,
          },
        }
        const commitPage = () => dmStore.commitConversationPage({
          account,
          conversation,
          rawMessages: newMessages,
          meta: pendingMeta,
          archivedAt: clock().toISOString(),
        })
        const { meta: committedMeta } = await withRetry(
          commitPage,
          { sleep, onRetry, stage: 'commit' },
        )
        meta = committedMeta
        onProgress({
          status: 'running',
          committedPages: meta.activeRun.committedPages,
          count: meta.counts.directMessages || 0,
          conversationCount: meta.directMessages.conversationCount,
          meta,
        })
        pageNumber += 1
        await sleep(REQUEST_INTERVAL_MS)
      }
      if (pageNumber > 200) throw new Error('私信会话超过 200 页，已安全停止')

      meta = {
        ...meta,
        activeRun: {
          ...meta.activeRun,
          nextConversationId: null,
          nextMessagePage: 1,
        },
      }
      await store.writeMeta(meta)
    }

    if (!resumeFound) throw new Error('上次私信同步的会话已不在当前列表中，请重新开始')
    meta = finishRun(meta, clock().toISOString())
    await store.writeMeta(meta)
    onProgress({ status: 'completed', count: meta.counts?.directMessages || 0, meta })
    return { status: 'completed', meta }
  } catch (error) {
    meta = stopRun(meta, 'error', clock().toISOString(), error?.message || String(error))
    await store.writeMeta(meta)
    throw error
  }
}
