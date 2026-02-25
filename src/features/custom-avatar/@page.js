import select from 'select-dom'
import {
  CUSTOM_AVATAR_STORAGE_AREA,
  CUSTOM_AVATAR_STORAGE_KEY,
} from './constants'
import { STORAGE_CHANGED } from '@constants'
import getLoggedInUserId from '@libs/getLoggedInUserId'

const ATTRIBUTE_ORIGINAL_SRC = 'data-sf-custom-avatar-original-src'
const AVATAR_IMAGE_SELECTOR = [
  '.avatar img',
  '#avatar img',
  '#user_top img',
].join(', ')

function normalizeUserId(userId) {
  if (!userId) return ''

  const rawUserId = String(userId)
  let decodedUserId

  try {
    decodedUserId = decodeURIComponent(rawUserId)
  } catch {
    decodedUserId = rawUserId
  }

  return decodedUserId
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function parseUserIdFromUrl(url) {
  if (!url) return ''

  try {
    const parsedUrl = new URL(url, window.location.origin)
    const [ userId = '' ] = parsedUrl.pathname.replace(/^\/+/, '').split('/')

    return normalizeUserId(userId)
  } catch {
    return ''
  }
}

function getUserIdFromStatusAvatar(image) {
  const statusElement = image.closest('li')
  if (!statusElement) return ''

  const authorLink = select('.author[href], .author a[href]', statusElement)

  return parseUserIdFromUrl(authorLink?.getAttribute('href'))
}

function getUserIdFromAvatarLink(image) {
  const avatarLink = image.closest('a[href]')

  return parseUserIdFromUrl(avatarLink?.getAttribute('href'))
}

function getUserIdFromKnownContainers(image) {
  if (image.closest('#user_top')) {
    return normalizeUserId(getLoggedInUserId())
  }

  return ''
}

function getImageOwnerUserId(image) {
  return (
    getUserIdFromStatusAvatar(image) ||
    getUserIdFromAvatarLink(image) ||
    getUserIdFromKnownContainers(image)
  )
}

function getAvatarImagesByUserId(userId) {
  const normalizedUserId = normalizeUserId(userId)
  if (!normalizedUserId) return []

  return select.all(AVATAR_IMAGE_SELECTOR)
    .filter(image => getImageOwnerUserId(image) === normalizedUserId)
}

function restoreReplacedAvatarImages() {
  const selector = `img[${ATTRIBUTE_ORIGINAL_SRC}]`

  for (const image of select.all(selector)) {
    const originalSrc = image.getAttribute(ATTRIBUTE_ORIGINAL_SRC)

    if (originalSrc === null) continue

    if (originalSrc) {
      image.setAttribute('src', originalSrc)
    } else {
      image.removeAttribute('src')
    }

    image.removeAttribute(ATTRIBUTE_ORIGINAL_SRC)
  }
}

function replaceAvatarImages({ userId, avatarUrl }) {
  for (const image of getAvatarImagesByUserId(userId)) {
    if (!image.hasAttribute(ATTRIBUTE_ORIGINAL_SRC)) {
      image.setAttribute(ATTRIBUTE_ORIGINAL_SRC, image.getAttribute('src') || '')
    }

    image.setAttribute('src', avatarUrl)
  }
}

export default context => {
  const {
    requireModules,
    registerBroadcastListener,
    unregisterBroadcastListener,
  } = context
  const { storage } = requireModules([ 'storage' ])
  let mySpaceUserId = ''

  async function refreshCustomAvatar() {
    const avatarUrl = await storage.read(
      CUSTOM_AVATAR_STORAGE_KEY,
      CUSTOM_AVATAR_STORAGE_AREA,
    )
    mySpaceUserId = mySpaceUserId || normalizeUserId(getLoggedInUserId())

    restoreReplacedAvatarImages()

    if (typeof avatarUrl !== 'string' || !avatarUrl || !mySpaceUserId) return

    replaceAvatarImages({
      userId: mySpaceUserId,
      avatarUrl,
    })
  }

  function onStorageChanged(message) {
    if (message.action !== STORAGE_CHANGED) return

    const { key, storageAreaName } = message.payload || {}
    const isCustomAvatarStorageChanged = (
      key === CUSTOM_AVATAR_STORAGE_KEY &&
      storageAreaName === CUSTOM_AVATAR_STORAGE_AREA
    )

    if (isCustomAvatarStorageChanged) {
      refreshCustomAvatar()
    }
  }

  registerBroadcastListener(onStorageChanged)

  return {
    async onLoad() {
      await refreshCustomAvatar()
    },

    onSettingsChange() {
      refreshCustomAvatar()
    },

    onUnload() {
      unregisterBroadcastListener(onStorageChanged)
      restoreReplacedAvatarImages()
    },
  }
}
