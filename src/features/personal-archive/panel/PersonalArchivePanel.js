import { h, Component } from 'preact'
import createDirectoryHandleRepository from '../directoryHandleRepository'
import {
  queryDirectoryWritePermission,
  requestDirectoryWritePermission,
} from '../directoryPermissions'
import createFanfouClient from '../fanfouClient'
import createFileSystemArchiveStore from '../fsStore'
import syncOwnTimeline from '../sync'
import downloadArchiveMedia, { listAvailableMedia } from '../mediaDownloader'
import buildArchiveHtml from '../buildHtml'
import {
  SUMMARY_STORAGE_KEY,
  SUMMARY_STORAGE_AREA,
  toSummary,
} from '../archiveSummary'
import messaging from '@settings/messaging'

const handleRepository = createDirectoryHandleRepository()
const fanfouClient = createFanfouClient(messaging)
const permissionLabels = {
  unknown: '待检查',
  prompt: '需要确认',
  granted: '已允许',
  denied: '已拒绝',
}
const SETTINGS_TAB_URL = 'settings.html#personal-archive'

/**
 * 同步循环活在这个组件里。扩展图标弹出的设置页是 action popup，一失焦就被浏览器
 * 销毁，组件连同同步一起没了——用户看到的就是「备份莫名其妙停住」。
 *
 * chrome.tabs.getCurrent() 在 popup 里返回 undefined，在标签页里返回该标签页，
 * 这是区分两者的官方办法。popup 里只显示进度、不开工。
 */
async function detectRunningInPopup() {
  try {
    return !await chrome.tabs.getCurrent()
  } catch (error) {
    // 拿不准时按标签页处理：宁可让用户点了没反应，也不要把能用的入口藏掉。
    return false
  }
}

export default class PersonalArchivePanel extends Component {
  state = {
    loading: true,
    isPopup: false,
    working: false,
    pauseRequested: false,
    directoryName: null,
    permission: 'unknown',
    meta: null,
    progress: null,
    mediaProgress: null,
    offlineResult: null,
    authorization: null,
    error: null,
  }

  directoryHandle = null

  componentDidMount() {
    this.detectSurface()
    this.restoreDirectory()
    this.loadAuthorizedAccount()
  }

  async detectSurface() {
    this.setState({ isPopup: await detectRunningInPopup() })
  }

  handleOpenInTab = async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL(SETTINGS_TAB_URL) })
    // 弹窗留着也没用了，而且它盖在新标签页前面。
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

    // 同步中逐页写没有意义（一次全量就是几百次写），等这一轮停下来再落一次。
    if (this.state.working || (!changed && !stoppedWorking)) return

    this.publishSummary()
  }

  /**
   * 把摘要写进 chrome.storage，供饭否首页侧栏的入口显示。
   * 首页拿不到备份目录句柄（origin 不同），这是它唯一的信息来源。
   */
  publishSummary() {
    const { meta, directoryName, offlineResult } = this.state
    const summary = toSummary(meta, {
      directoryName,
      hasOfflinePages: Boolean(offlineResult),
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

  handleStartSync = async () => {
    if (!this.directoryHandle || this.state.working) return

    this.setState({
      working: true,
      pauseRequested: false,
      error: null,
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
      const result = await syncOwnTimeline({
        account,
        fetchPage: query => fanfouClient.fetchOwnTimeline(query),
        store,
        shouldPause: () => this.state.pauseRequested,
        onProgress: progress => this.setState({
          progress,
          meta: progress.meta,
        }),
      })

      this.setState({
        working: false,
        pauseRequested: false,
        meta: result.meta,
        progress: {
          status: result.status,
          count: result.meta.counts.statuses,
        },
      })
    } catch (error) {
      this.setState({
        working: false,
        pauseRequested: false,
        error: this.getErrorMessage(error),
      })
    }
  }

  handlePause = () => {
    this.setState({ pauseRequested: true })
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
    const availableMedia = await listAvailableMedia(statuses, store, meta)
    const files = buildArchiveHtml({ meta, statuses, availableMedia })

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

  getErrorMessage(error) {
    return error?.message || String(error)
  }

  getSyncButtonLabel() {
    const { meta } = this.state
    if (meta?.activeRun) return '继续上次同步'
    if (meta?.watermark?.statuses?.reachedFirstEver) return '同步新消息'
    return '开始完整同步'
  }

  getPermissionLabel() {
    return permissionLabels[this.state.permission] || '未知'
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

  // 弹窗一关同步就断，所以这里不给任何会开工的按钮，只把人送到标签页去。
  renderPopupNotice() {
    return (
      <div className="sf-personal-archive-panel__popup-notice">
        <p>
          <strong>备份不能在这个弹窗里进行。</strong>
          这个弹窗一失去焦点就会被浏览器关掉，正在跑的备份会跟着中断。
          请在标签页里操作，中途切走也不会断。
        </p>
        <div className="sf-personal-archive-panel__actions">
          <button type="button" onClick={this.handleOpenInTab}>
            在标签页中打开备份
          </button>
        </div>
      </div>
    )
  }

  renderActions() {
    const { working, pauseRequested, directoryName, meta } = this.state

    return (
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
          onClick={this.handleBuildOffline}
        >
          生成离线页面
        </button>
      </div>
    )
  }

  render() {
    const {
      loading,
      isPopup,
      directoryName,
      meta,
      progress,
      mediaProgress,
      offlineResult,
      error,
    } = this.state

    return (
      <div className="sf-personal-archive-panel">
        <p>把自己的饭否消息按月写入你选择的本地文件夹。备份中不会写入 OAuth token、Cookie 或签名。</p>

        { this.renderAuthorizedAccount() }

        { loading && <p>正在读取备份文件夹…</p> }
        { !loading && (isPopup ? this.renderPopupNotice() : (
          <div>
            <p>
              备份文件夹：{ directoryName || '尚未选择' }
              { directoryName && `（权限：${this.getPermissionLabel()}）` }
            </p>
            { this.renderActions() }
          </div>
        )) }

        { meta && (
          <ul className="sf-personal-archive-panel__summary">
            <li>已落盘消息：{ meta.counts?.statuses || 0 } 条</li>
            <li>最早水位：{ meta.watermark?.statuses?.oldestId || '尚无' }</li>
            <li>最近完成同步：{ meta.lastSyncedAt || '尚未完成全量同步' }</li>
            { meta.activeRun && <li>检测到未完成同步，可从已提交水位继续。</li> }
          </ul>
        ) }

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
        { error && <p className="sf-personal-archive-panel__error">⚠️ { error }</p> }
      </div>
    )
  }
}
