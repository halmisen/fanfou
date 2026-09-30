import select from 'select-dom'
import elementReady from 'element-ready'
import messaging from '@content/environment/messaging'
import log from '@libs/log'
import { isSharePage } from '@libs/pageDetect'
import { SHARE_TO_FANFOU_SHARED } from '@constants'

// 饭否分享页自己会在成功后调 window.close()，但 MV3 的分享窗口是
// chrome.windows.create() 建的，不算「脚本打开的窗口」，Chrome 拒绝它自关。
// 所以改由这里认出成功状态，再让 background 用 windowId 关掉。
const SUCCESS_TEXT = '分享成功'
// 饭否原本的文案是「本窗口数秒后将自动关闭」，留一点时间让用户看清结果。
const CLOSE_DELAY = 2500
const TEXTAREA_READY_TIMEOUT = 10000

// 只认「整段文字正好等于分享成功」的叶子节点，并且排除表单内部——
// 否则用户选中的文字里正好带这四个字时，窗口会在发送前就被关掉。
function findSuccessNode() {
  for (const element of select.all('body *')) {
    if (element.children.length) continue
    if (element.closest('form')) continue
    if (element.textContent.trim() === SUCCESS_TEXT) return element
  }

  return null
}

export default context => {
  const { readOptionValue } = context

  let observer = null
  let closeTimer = null
  let notified = false

  function notifyShared() {
    if (notified) return
    notified = true

    closeTimer = setTimeout(() => {
      closeTimer = null
      messaging.postMessage({ action: SHARE_TO_FANFOU_SHARED }).catch(error => {
        // 关不掉窗口不该冒泡成页面错误，最差就是维持现在「窗口不关」的行为。
        log.error('通知 background 关闭分享窗口失败：', error)
      })
    }, CLOSE_DELAY)
  }

  function watchForSuccess() {
    // 分享可能是整页跳转（成功页直接就在文档里），也可能是原地替换 DOM，两种都要认。
    if (findSuccessNode()) {
      notifyShared()
      return
    }

    observer = new MutationObserver(() => {
      if (!findSuccessNode()) return

      observer.disconnect()
      observer = null
      notifyShared()
    })

    observer.observe(document.body, { childList: true, subtree: true })
  }

  /**
   * 把输入框改写成用户真正想发的内容。
   *
   * 饭否默认拼成「分享:《标题》 链接 选中文字」。用户在时间线里划一句话分享时，
   * 那个链接指向的是列表页而不是那条消息，对读者没有意义，所以默认只留选中文字。
   * 没有选中文字（整页右键分享）时不动它——那时标题和链接就是全部信息。
   */
  async function fillShareText() {
    const params = new URLSearchParams(window.location.search)
    const selectionText = (params.get('d') || '').trim()
    if (!selectionText) return

    const pageUrl = params.get('u') || ''
    const shareText = readOptionValue('includePageUrl') && pageUrl
      ? `${selectionText} ${pageUrl}`
      : selectionText

    const textarea = await elementReady('textarea', { timeout: TEXTAREA_READY_TIMEOUT })
    if (!textarea) return

    textarea.value = shareText
    // 饭否自己的字数统计挂在 input 上，不派发的话计数会停在旧文本。
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
  }

  return {
    applyWhen: () => isSharePage(),

    async onLoad() {
      await messaging.ready()
      await fillShareText()
      watchForSuccess()
    },

    onUnload() {
      if (observer) observer.disconnect()
      observer = null

      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }

      notified = false
    },
  }
}
