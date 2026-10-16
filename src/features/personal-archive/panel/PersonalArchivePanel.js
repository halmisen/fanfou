import { h, Component, Fragment } from 'preact'
import createDirectoryHandleRepository from '../directoryHandleRepository'
import {
  queryDirectoryWritePermission,
  requestDirectoryWritePermission,
} from '../directoryPermissions'
import createFanfouClient from '../fanfouClient'
import createFileSystemArchiveStore from '../fsStore'
import isPopupContext from '../popupContext'
import syncOwnTimeline, { syncStatusStream } from '../sync'
import syncDirectMessages from '../directMessageSync'
import createDirectMessageStore from '../directMessageStore'
import probeDirectMessages from '../directMessageProbe'
import downloadArchiveMedia, { listAvailableMedia } from '../mediaDownloader'
import buildArchiveHtml from '../buildHtml'
import createNostalgiaCache from '../nostalgiaCache'
import {
  SUMMARY_STORAGE_KEY,
  SUMMARY_STORAGE_AREA,
  toSummary,
} from '../archiveSummary'
import messaging from '@settings/messaging'

const handleRepository = createDirectoryHandleRepository()
const nostalgiaCache = createNostalgiaCache()
const fanfouClient = createFanfouClient(messaging)
// 首页侧栏那行字几秒更新一次就够了，逐页写只是徒增 storage 广播。
const SUMMARY_PUBLISH_INTERVAL_MS = 3000
const permissionLabels = {
  unknown: '待检查',
  prompt: '需要确认',
  granted: '已允许',
  denied: '已拒绝',
}
const resourceLabels = {
  statuses: '消息',
  mentions: '提及',
  favorites: '收藏',
  directMessages: '私信',
}

export default class PersonalArchivePanel extends Component {
  state = {
    inPopup: null,
    loading: true,
    working: false,
    pauseRequested: false,
    directoryName: null,
    permission: 'unknown',
    meta: null,
    progress: null,
    mediaProgress: null,
    offlineResult: null,
    nostalgiaResult: null,
    dmProbeReceipt: null,
    authorization: null,
    retryNotice: null,
    error: null,
  }

  directoryHandle = null

  lastPublishedAt = 0

  componentDidMount() {
    this.detectPopupContext()
    this.restoreDirectory()
    this.loadAuthorizedAccount()
  }

  async detectPopupContext() {
    this.setState({ inPopup: await isPopupContext() })
  }

  handleOpenInTab = async () => {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('settings.html#personal-archive'),
    })
    window.close()
  }

  // 备份跟着 OAuth 授权走，不跟着网页登录走。多账号用户在网页切了号以后，
  // 备份的仍然是原来授权的那个账号——必须在开始同步之前就把它显示出来。
  async loadAuthorizedAccount() {
    try {
      this.setState({ authorization: await fanfouClient.fetchAuthorizationStatus() })
    } catch (error) {
      this.setState({ authorization: null })
    }
  }

  componentDidUpdate(previousProps, previousState) {
    const stoppedWorking = previousState.working && !this.state.working
    const changed = (
      this.state.meta !== previousState.meta ||
      this.state.directoryName !== previousState.directoryName ||
      this.state.offlineResult !== previousState.offlineResult
    )

    // 同步中也要发布，否则首页侧栏那行字会整整二十分钟不动，看起来像卡死了。
    // 但逐页写没必要（一次全量几百页），节流到几秒一次。
    if (this.state.working) {
      this.publishSummaryThrottled()
      return
    }

    if (!changed && !stoppedWorking) return

    this.publishSummary()
  }

  publishSummaryThrottled() {
    if (Date.now() - this.lastPublishedAt < SUMMARY_PUBLISH_INTERVAL_MS) return

    this.publishSummary()
  }

  /**
   * 把摘要写进 chrome.storage，供饭否首页侧栏的入口显示。
   * 首页拿不到备份目录句柄（origin 不同），这是它唯一的信息来源。
   */
  publishSummary() {
    const { meta, directoryName, offlineResult, working } = this.state

    this.lastPublishedAt = Date.now()

    const summary = toSummary(meta, {
      directoryName,
      hasOfflinePages: Boolean(offlineResult),
      isRunning: working,
      updatedAt: new Date().toISOString(),
    })

    // 写失败只影响首页那行字，不该让备份流程报错。
    chrome.storage[SUMMARY_STORAGE_AREA].set({ [SUMMARY_STORAGE_KEY]: summary })
  }

  async restoreDirectory() {
    try {
      const directoryHandle = await handleRepository.load()
      if (!directoryHandle) {
        this.setState({ loading: false })
        return
      }

      this.directoryHandle = directoryHandle
      const permission = await queryDirectoryWritePermission(directoryHandle)
      const meta = await createFileSystemArchiveStore(directoryHandle).readMeta()
      this.setState({
        loading: false,
        directoryName: directoryHandle.name,
        permission,
        meta,
      })
    } catch (error) {
      this.setState({
        loading: false,
        error: this.getErrorMessage(error),
      })
    }
  }

  handleChooseDirectory = async () => {
    this.setState({ error: null })

    try {
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new TypeError('当前 Chrome 不支持目录访问，请更新浏览器后重试')
      }

      const directoryHandle = await window.showDirectoryPicker({
        id: 'space-fanfou-personal-archive',
        mode: 'readwrite',
        startIn: 'documents',
      })
      await handleRepository.save(directoryHandle)

      this.directoryHandle = directoryHandle
      const permission = await queryDirectoryWritePermission(directoryHandle)
      const meta = await createFileSystemArchiveStore(directoryHandle).readMeta()
      this.setState({
        directoryName: directoryHandle.name,
        permission,
        meta,
        progress: null,
      })
    } catch (error) {
      if (error?.name !== 'AbortError') {
        this.setState({ error: this.getErrorMessage(error) })
      }
    }
  }

  handleStartSync = () => {
    return this.handleStartStream({
      resource: 'statuses',
      archiveSource: 'ownTimeline',
      fetchPage: query => fanfouClient.fetchOwnTimeline(query),
    })
  }

  handleStartMentions = () => {
    return this.handleStartStream({
      resource: 'mentions',
      archiveSource: 'mention',
      fetchPage: query => fanfouClient.fetchMentions(query),
    })
  }

  handleStartFavorites = () => {
    return this.handleStartStream({
      resource: 'favorites',
      archiveSource: 'favorite',
      fetchPage: query => fanfouClient.fetchFavorites(query),
    })
  }

  handleStartDirectMessages = async () => {
    if (!this.directoryHandle || this.state.working) return
    // eslint-disable-next-line no-alert
    if (!window.confirm('将把当前 OAuth 账号的私信保存到所选本地文件夹。私信页面没有访问控制，请确认该文件夹仅自己可访问。继续吗？')) return

    this.setState({
      working: true,
      pauseRequested: false,
      error: null,
      retryNotice: null,
      progress: null,
    })

    try {
      const permission = await requestDirectoryWritePermission(this.directoryHandle)
      this.setState({ permission })
      if (permission !== 'granted') throw new Error('没有获得备份文件夹写入权限，请重新点击并允许访问')

      const account = await fanfouClient.fetchCurrentAccount()
      const result = await syncDirectMessages({
        account,
        client: fanfouClient,
        store: createFileSystemArchiveStore(this.directoryHandle),
        shouldPause: () => this.state.pauseRequested,
        onProgress: progress => this.setState({ progress, meta: progress.meta }),
      })
      this.setState({
        working: false,
        pauseRequested: false,
        meta: result.meta,
        progress: { status: result.status, resource: 'directMessages', count: result.meta.counts.directMessages || 0 },
      })
    } catch (error) {
      console.error('[SpaceFanfou] 私信归档同步中断:', error)
      this.setState({ working: false, pauseRequested: false, error: this.getErrorMessage(error) })
    }
  }

  handleStartStream = async ({ resource, archiveSource, fetchPage }) => {
    if (!this.directoryHandle || this.state.working) return

    this.setState({
      working: true,
      pauseRequested: false,
      error: null,
      retryNotice: null,
      progress: null,
    })

    // 用户可能刚在上方「API 接入」重新授权过，显示的账号要跟上
    this.loadAuthorizedAccount()

    try {
      // 必须是点击后的第一个异步动作，避免 user activation 在 OAuth/API await 中丢失。
      const permission = await requestDirectoryWritePermission(this.directoryHandle)
      this.setState({ permission })
      if (permission !== 'granted') {
        throw new Error('没有获得备份文件夹写入权限，请重新点击并允许访问')
      }

      const account = await fanfouClient.fetchCurrentAccount()
      const store = createFileSystemArchiveStore(this.directoryHandle)
      const sync = resource === 'statuses' ? syncOwnTimeline : syncStatusStream
      const result = await sync({
        account,
        resource,
        archiveSource,
        fetchPage,
        store,
        shouldPause: () => this.state.pauseRequested,
        onProgress: progress => this.setState({
          progress,
          meta: progress.meta,
          retryNotice: null,
        }),
        onRetry: ({ attempt, maxAttempts, delay, error }) => this.setState({
          retryNotice: `连接不稳定，${delay / 1000} 秒后重试第 ${attempt}/${maxAttempts - 1} 次：`
            + this.getErrorMessage(error),
        }),
        onCommitted: async ({ resource: committedResource, statuses, meta }) => {
          if (committedResource !== 'statuses') return
          try {
            await nostalgiaCache.writeStatuses(statuses, meta.archiveTimezone)
          } catch (error) {
            // 备份文件已成功落盘；索引可从设置页重新建立，不能反过来判定备份失败。
            console.error('[SpaceFanfou] 首页怀旧索引写入失败:', error)
          }
        },
      })

      this.setState({
        working: false,
        pauseRequested: false,
        retryNotice: null,
        meta: result.meta,
        progress: {
          status: result.status,
          resource,
          count: result.meta.counts[resource] || 0,
        },
      })
    } catch (error) {
      // 面板里的错误文本只活在内存里，标签页一关就没了；控制台留一份才能事后回溯。
      console.error('[SpaceFanfou] 个人归档同步中断:', error)
      this.setState({
        working: false,
        pauseRequested: false,
        retryNotice: null,
        error: this.getErrorMessage(error),
      })
    }
  }

  handlePause = () => {
    this.setState({ pauseRequested: true })
  }

  handleProbeDirectMessages = async () => {
    if (this.state.working) return
    // eslint-disable-next-line no-alert
    if (!window.confirm('将通过当前 OAuth 授权只读探测一个私信会话，不保存消息正文或账号标识。继续吗？')) return

    this.setState({ working: true, error: null, dmProbeReceipt: null })

    try {
      const dmProbeReceipt = await probeDirectMessages({ client: fanfouClient })
      this.setState({ working: false, dmProbeReceipt })
    } catch (error) {
      this.setState({
        working: false,
        error: '私信探针未能完成，请检查 OAuth 授权后重试。',
      })
    }
  }

  // 下载图片与生成离线页面都要先拿到写权限，且必须是点击后的第一个异步动作。
  async withWritableDirectory(run) {
    if (!this.directoryHandle || this.state.working) return

    this.setState({ working: true, pauseRequested: false, error: null })

    try {
      const permission = await requestDirectoryWritePermission(this.directoryHandle)
      this.setState({ permission })
      if (permission !== 'granted') {
        throw new Error('没有获得备份文件夹写入权限，请重新点击并允许访问')
      }

      const store = createFileSystemArchiveStore(this.directoryHandle)
      const meta = await store.readMeta()
      if (!meta) throw new Error('还没有备份数据，请先完成一次同步')

      await run(store, meta)
      this.setState({ working: false, pauseRequested: false })
    } catch (error) {
      this.setState({
        working: false,
        pauseRequested: false,
        error: this.getErrorMessage(error),
      })
    }
  }

  handleDownloadMedia = () => this.withWritableDirectory(async (store, meta) => {
    const statuses = await store.readAllStatuses(meta)
    const result = await downloadArchiveMedia({
      statuses,
      store,
      meta,
      shouldPause: () => this.state.pauseRequested,
      onProgress: mediaProgress => this.setState({ mediaProgress }),
    })

    this.setState({ meta: result.meta, mediaProgress: result })
  })

  handleBuildOffline = () => this.withWritableDirectory(async (store, meta) => {
    const statuses = await store.readAllStatuses(meta)
    const mentions = await store.readAllMentions(meta)
    const favorites = await store.readAllFavorites(meta)
    const directMessages = await createDirectMessageStore(store).readAllDirectMessages()
    const availableMedia = await listAvailableMedia(statuses, store, meta)
    const files = buildArchiveHtml({ meta, statuses, mentions, favorites, directMessages, availableMedia })

    for (const [ path, contents ] of Object.entries(files)) {
      await store.writeTextFile(path, contents)
    }

    this.setState({
      offlineResult: {
        pages: Object.keys(files).filter(name => name.endsWith('.html')).length,
        photos: availableMedia.size,
      },
    })
  })

  // 已存在的本地备份早于首页怀旧缓存时，用户只需执行一次。逐月读写，避免把整库同时放进内存。
  handleBuildNostalgiaCache = () => this.withWritableDirectory(async (store, meta) => {
    const months = store.listStatusShards(meta)
    let written = 0

    for (const month of months) {
      const statuses = await store.readStatusMonth(month)
      await nostalgiaCache.writeStatuses(statuses, meta.archiveTimezone)
      written += statuses.length
    }

    this.setState({ nostalgiaResult: { months: months.length, written } })
  })

  getErrorMessage(error) {
    return error?.message || String(error)
  }

  /**
   * 中断诊断信息全部来自 meta.json，不依赖本次页面加载的内存状态。
   * 用户重开设置页时最需要回答的是「为什么停、停在哪」——这两个答案早就落盘了，
   * 之前只是没有显示出来。
   */
  renderUnfinishedRun(activeRun) {
    const { stopReason, stoppedAt, lastError, committedPages, nextMaxId } = activeRun
    const reasonText = {
      paused: '上次是你主动暂停的。',
      error: '上次是出错中断的。',
    }[stopReason] || '上次没有留下停止原因，可能是标签页被关闭或被浏览器回收。'

    return (
      <Fragment>
        <li>检测到未完成的{resourceLabels[activeRun.resource] || '归档'}同步，可从已提交水位继续。{ reasonText }也可以先同步其他种类，原进度会保留。</li>
        <li>
          上次进度：已提交 { committedPages || 0 } 页
          { nextMaxId && `，下一页游标 ${nextMaxId}` }
          { stoppedAt && `，停止时间 ${stoppedAt}` }。
        </li>
        { lastError && (
          <li className="sf-personal-archive-panel__error">
            上次的失败原因：{ lastError.message }
          </li>
        ) }
      </Fragment>
    )
  }

  getSyncButtonLabel() {
    const { meta } = this.state
    if (this.getUnfinishedRun('statuses')) return '继续上次同步'
    if (meta?.watermark?.statuses?.reachedFirstEver) return '同步新消息'
    return '开始完整同步'
  }

  getMentionButtonLabel() {
    const { meta } = this.state
    if (this.getUnfinishedRun('mentions')) return '继续提及同步'
    if (meta?.watermark?.mentions?.reachedFirstEver) return '同步新的提及'
    return '同步收到的提及'
  }

  getDirectMessageButtonLabel() {
    if (this.getUnfinishedRun('directMessages')) return '继续私信同步'
    return '备份私信'
  }

  getFavoriteButtonLabel() {
    const { meta } = this.state
    if (this.getUnfinishedRun('favorites')) return '继续收藏同步'
    if (meta?.watermark?.favorites?.reachedFirstEver) return '同步新的收藏'
    return '同步收藏'
  }

  getPermissionLabel() {
    return permissionLabels[this.state.permission] || '未知'
  }

  getUnfinishedRun(resource) {
    const { meta } = this.state
    return meta?.activeRun?.resource === resource ? meta.activeRun : meta?.pendingRuns?.[resource]
  }

  renderDirectMessageProbeReceipt(receipt) {
    if (!receipt) return null

    const list = receipt.conversationList
    const sample = receipt.sampleConversation

    return (
      <div className="sf-personal-archive-panel__summary">
        <p>私信只读探针收据（未写入备份目录）：</p>
        <ul>
          <li>
            对话列表：{ list.available ? '可访问' : '不可访问' }，读取 { list.pagesFetched } 页，
            去重 { list.uniqueConversations } 个会话
            { list.reachedEmptyPage ? '，已到空页。' : '。' }
            { list.errorCategory && `错误类别：${list.errorCategory}。` }
          </li>
          { sample && (
            <li>
              受控会话：读取 { sample.pagesFetched } 页，去重 { sample.uniqueMessages } 条，
              { sample.reachedEmptyPage ? '已到空页；' : '未到空页；' }
              { sample.matchesExpectedMessages === null
                ? '未获得可比对的 msg_num。'
                : sample.matchesExpectedMessages ? 'msg_num 一致。' : 'msg_num 不一致。' }
              { sample.errorCategory && `错误类别：${sample.errorCategory}。` }
            </li>
          ) }
        </ul>
      </div>
    )
  }

  /**
   * 备份哪个账号由 OAuth 授权决定，与网页当前登录的账号无关。
   * 有两个号的用户在网页上切了号，很容易以为备份也跟着切了——所以这行必须显眼，
   * 而且要点破「不随网页登录切换」，光显示账号名不够。
   */
  renderAuthorizedAccount() {
    const { authorization } = this.state

    if (!authorization) return null

    if (!authorization.hasTokens) {
      return (
        <p className="sf-personal-archive-panel__account">
          ⚠️ 尚未完成授权，请先到上方「API 接入」完成授权。
        </p>
      )
    }

    const name = authorization.screenName || authorization.userId || '未知'

    return (
      <p className="sf-personal-archive-panel__account">
        将备份账号：<strong>{ name }</strong>
        <br />
        这个账号由「API 接入」的 OAuth 授权决定，<strong>不随饭否网页切换账号而改变</strong>。
        要备份另一个账号：先在饭否网页登录那个账号，再到上方「API 接入」取消授权并重新授权，
        然后为它另选一个空文件夹。
      </p>
    )
  }

  // 图床域名不在白名单时不静默跳过——把域名显示出来，用户反馈后加进 manifest 即可。
  renderSkippedHosts(skippedByHost) {
    const hosts = Object.entries(skippedByHost || {})
    if (!hosts.length) return null

    const summary = hosts.map(([ host, count ]) => `${host}（${count} 张）`).join('、')
    return ` 另有未授权域名被跳过：${summary}，请把它反馈给开发者。`
  }

  // popup 里不显示任何操作按钮：能点的都是长任务或需要系统对话框，点了必然半途而废。
  renderPopupNotice() {
    return (
      <div className="sf-personal-archive-panel">
        <p>
          备份要在<strong>独立标签页</strong>里进行。
          现在这个窗口是点扩展图标弹出的浮层，鼠标点到别处它就会关闭，
          关闭时正在进行的同步会立刻中断——全量备份是二十分钟起步的长任务，在这里跑不完。
        </p>
        <div className="sf-personal-archive-panel__actions">
          <button type="button" onClick={this.handleOpenInTab}>
            在新标签页中打开备份页面
          </button>
        </div>
        <p className="formtip">
          饭否首页侧栏的「本地备份」入口打开的就是独立标签页，效果一样。
        </p>
      </div>
    )
  }

  render() {
    // 判定出来之前不渲染任何按钮，避免 popup 里闪出一个点了就会半途而废的「开始同步」。
    if (this.state.inPopup === null) {
      return (
        <div className="sf-personal-archive-panel">
          <p>正在准备…</p>
        </div>
      )
    }
    if (this.state.inPopup) return this.renderPopupNotice()

    const {
      loading,
      working,
      pauseRequested,
      directoryName,
      meta,
      progress,
      mediaProgress,
      offlineResult,
      nostalgiaResult,
      dmProbeReceipt,
      retryNotice,
      error,
    } = this.state

    return (
      <div className="sf-personal-archive-panel">
        <p>把自己的饭否消息按月写入你选择的本地文件夹。备份中不会写入 OAuth token、Cookie 或签名。</p>

        { this.renderAuthorizedAccount() }

        { loading && <p>正在读取备份文件夹…</p> }
        { !loading && (
          <div>
            <p>
              备份文件夹：{ directoryName || '尚未选择' }
              { directoryName && `（权限：${this.getPermissionLabel()}）` }
            </p>
            <div className="sf-personal-archive-panel__actions">
              <button type="button" disabled={working} onClick={this.handleChooseDirectory}>
                { directoryName ? '更换备份文件夹' : '选择备份文件夹' }
              </button>
              <button
                type="button"
                disabled={!directoryName || working}
                onClick={this.handleStartSync}
              >
                { this.getSyncButtonLabel() }
              </button>
              <button
                type="button"
                disabled={!directoryName || working}
                onClick={this.handleStartMentions}
              >
                { this.getMentionButtonLabel() }
              </button>
              <button
                type="button"
                disabled={!directoryName || working}
                onClick={this.handleStartFavorites}
              >
                { this.getFavoriteButtonLabel() }
              </button>
              <button
                type="button"
                disabled={!directoryName || working}
                onClick={this.handleStartDirectMessages}
              >
                { this.getDirectMessageButtonLabel() }
              </button>
              <button
                type="button"
                disabled={!working || pauseRequested}
                onClick={this.handlePause}
              >
                { pauseRequested ? '将在本页完成后暂停…' : '暂停' }
              </button>
              <button
                type="button"
                disabled={!directoryName || working || !meta}
                onClick={this.handleDownloadMedia}
              >
                下载图片
              </button>
              <button
                type="button"
                disabled={!directoryName || working || !meta}
                onClick={this.handleBuildNostalgiaCache}
              >
                建立首页怀旧索引
              </button>
              <button
                type="button"
                disabled={!directoryName || working || !meta}
                onClick={this.handleBuildOffline}
              >
                生成离线页面
              </button>
              <button
                type="button"
                disabled={working}
                onClick={this.handleProbeDirectMessages}
              >
                检查私信接口（不写入）
              </button>
            </div>
          </div>
        ) }

        { meta && (
          <ul className="sf-personal-archive-panel__summary">
            <li>已落盘消息：{ meta.counts?.statuses || 0 } 条</li>
            <li>最早水位：{ meta.watermark?.statuses?.oldestId || '尚无' }</li>
            <li>最近完成同步：{ meta.lastSyncedAt || '尚未完成全量同步' }</li>
            <li>已落盘收到的提及：{ meta.counts?.mentions || 0 } 条</li>
            <li>最近完成提及同步：{ meta.lastSyncedAtByResource?.mentions || '尚未完成完整同步' }</li>
            <li>已落盘收藏：{ meta.counts?.favorites || 0 } 条</li>
            <li>最近完成收藏同步：{ meta.lastSyncedAtByResource?.favorites || '尚未完成完整同步' }</li>
            <li>已落盘私信：{ meta.counts?.directMessages || 0 } 条（{ meta.directMessages?.conversationCount || 0 } 个会话）</li>
            <li>最近完成私信同步：{ meta.lastSyncedAtByResource?.directMessages || '尚未完成完整同步' }</li>
            { meta.activeRun && this.renderUnfinishedRun(meta.activeRun) }
            { Object.values(meta.pendingRuns || {}).map(run => this.renderUnfinishedRun(run)) }
          </ul>
        ) }

        { retryNotice && <p className="sf-personal-archive-panel__retry">⏳ { retryNotice }</p> }

        { progress?.status === 'running' && (
          <p>
            已提交 { progress.committedPages } 页，磁盘共有 { progress.count } 条；
            下一页游标 { progress.nextMaxId }。
          </p>
        ) }
        { progress?.status === 'paused' && <p>同步已在页边界暂停，可以稍后继续。</p> }
        { progress?.status === 'completed' && <p>本轮同步完成，共 { progress.count } 条。</p> }

        { mediaProgress?.status === 'running' && (
          <p>正在下载图片：{ mediaProgress.processed } / { mediaProgress.total }。</p>
        ) }
        { mediaProgress && mediaProgress.status !== 'running' && (
          <p>
            { mediaProgress.status === 'paused' ? '图片下载已暂停' : '图片下载完成' }：
            新下载 { mediaProgress.downloaded } 张，已存在跳过 { mediaProgress.skippedExisting } 张
            { mediaProgress.failures?.length > 0 && `，失败 ${mediaProgress.failures.length} 张` }。
            { this.renderSkippedHosts(mediaProgress.skippedByHost) }
          </p>
        ) }
        { offlineResult && (
          <p>
            离线页面已生成：{ offlineResult.pages } 个 HTML 页面，
            引用了 { offlineResult.photos } 个本地图片文件。
            用文件管理器打开备份文件夹，双击 index.html 即可离线浏览。
          </p>
        ) }
        { nostalgiaResult && (
          <p>首页怀旧索引已建立：{ nostalgiaResult.months } 个月，{ nostalgiaResult.written } 条消息。</p>
        ) }
        { this.renderDirectMessageProbeReceipt(dmProbeReceipt) }
        { error && <p className="sf-personal-archive-panel__error">⚠️ { error }</p> }
      </div>
    )
  }
}
