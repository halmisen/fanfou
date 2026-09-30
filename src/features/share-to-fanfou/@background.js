import transformUrl from 'transform-url'
import messaging from '@background/environment/messaging'
import log from '@libs/log'
import { SHARE_TO_FANFOU_SHARED } from '@constants'

export default () => {
  // 参考：https://static.fanfou.com/js/bm_img_share.js

  const menuIds = []
  // Manifest V3: 不能在 create() 中使用 onclick，必须使用 onClicked 事件
  const menuItems = [ {
    id: 'share-to-fanfou-page',
    title: '分享到饭否',
    contexts: [ 'page', 'selection' ],
  // TODO: 拿不到链接标题
  // }, {
  //   id: 'share-to-fanfou-link',
  //   title: '分享链接到饭否',
  //   contexts: [ 'link' ],
  }, {
    id: 'share-to-fanfou-image',
    title: '分享图片到饭否',
    contexts: [ 'image' ],
  } ]

  function createSharerPopup(url, height) {
    // Service Worker 兼容：使用 chrome.windows.create 替代 window.open
    chrome.windows.create({
      url,
      type: 'popup',
      width: 640,
      height,
    })
  }

  // Manifest V3: 使用 onClicked 事件监听器处理点击
  function handleMenuClick(info, tab) {
    let url
    let height = 440

    switch (info.menuItemId) {
    case 'share-to-fanfou-page':
      url = transformUrl('https://fanfou.com/sharer', {
        u: tab.url,
        t: tab.title,
        d: info.selectionText || '',
      })
      height = 440
      break

    case 'share-to-fanfou-image':
      url = transformUrl('https://fanfou.com/sharer/image', {
        u: tab.url,
        t: tab.title,
        img_src: info.srcUrl, // eslint-disable-line camelcase
      })
      height = 540
      break

    default:
      return
    }

    createSharerPopup(url, height)
  }

  function registerMenuItems() {
    // Manifest V3: Service Worker 可能重启，先清理旧菜单避免重复
    chrome.contextMenus.removeAll(() => {
      menuIds.length = 0

      for (const menuItem of menuItems) {
        chrome.contextMenus.create(menuItem, () => {
          if (chrome.runtime.lastError) {
            console.error('[SpaceFanfou] 创建上下文菜单失败:', chrome.runtime.lastError.message)
          } else {
            menuIds.push(menuItem.id)
          }
        })
      }

      // 注册点击事件监听器
      chrome.contextMenus.onClicked.addListener(handleMenuClick)
    })
  }

  function unregisterMenuItems() {
    // 移除点击事件监听器
    chrome.contextMenus.onClicked.removeListener(handleMenuClick)

    menuIds.forEach(menuId => chrome.contextMenus.remove(menuId))
    menuIds.length = 0
  }

  /**
   * 分享页认出「分享成功」后，由这里替它关窗——页面自己调 window.close() 会被
   * Chrome 拒绝，因为窗口不是脚本打开的。
   *
   * windowId 取自消息发送方，不依赖任何内存状态，Service Worker 重启后照样准确。
   * 只关 popup 类型的窗口：万一用户是在普通标签页里打开分享页，这里绝不能把
   * 他整个浏览器窗口关掉。
   */
  async function handleShared(payload, sender) {
    const windowId = sender?.tab?.windowId
    if (windowId == null) return

    try {
      const targetWindow = await chrome.windows.get(windowId)
      if (targetWindow.type !== 'popup') return

      await chrome.windows.remove(windowId)
    } catch (error) {
      // 窗口可能已经被用户手动关掉了，不是错误。
      log.debug('关闭分享窗口失败：', error)
    }
  }

  return {
    onLoad() {
      registerMenuItems()
      messaging.registerHandler(SHARE_TO_FANFOU_SHARED, handleShared)
    },

    onUnload() {
      unregisterMenuItems()
      messaging.unregisterHandler(SHARE_TO_FANFOU_SHARED)
    },
  }
}
