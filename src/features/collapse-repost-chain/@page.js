import select from 'select-dom'
import { on, off } from 'delegated-events'
import { isTimelinePage } from '@libs/pageDetect'
import isStatusElement from '@libs/isStatusElement'

const ATTRIBUTE_MARKER = 'sf-collapse-repost-chain'
const CLASSNAME_COLLAPSED = 'sf-collapse-repost-chain-collapsed'
const CLASSNAME_ORIGINAL = 'sf-collapse-repost-chain-original'
const CLASSNAME_PREVIEW = 'sf-collapse-repost-chain-preview'
const CLASSNAME_TOGGLE = 'sf-collapse-repost-chain-toggle'
const SELECTOR_TOGGLE = `.${CLASSNAME_TOGGLE}`
const REPOST_MARKER_REGEX = /\/\/\s*@[^:：\n]+\s*[:：]/g
const MIN_REPOST_MARKERS = 4
const MIN_REPOST_MARKERS_FOR_LONG_TEXT = 2
const MIN_LONG_TEXT_LENGTH = 260
const PREVIEW_LENGTH = 150

function normalizeText(rawText = '') {
  return rawText
    .replace(/\s+/g, ' ')
    .trim()
}

function shouldCollapse(text) {
  const repostMarkerCount = text.match(REPOST_MARKER_REGEX)?.length || 0

  if (repostMarkerCount >= MIN_REPOST_MARKERS) {
    return true
  }

  return (
    repostMarkerCount >= MIN_REPOST_MARKERS_FOR_LONG_TEXT &&
    text.length >= MIN_LONG_TEXT_LENGTH
  )
}

function createPreviewText(fullText) {
  if (fullText.length <= PREVIEW_LENGTH) {
    return null
  }

  return `${fullText.slice(0, PREVIEW_LENGTH).trimEnd()}…`
}

function setCollapsedState(content, button, isCollapsed) {
  content.classList.toggle(CLASSNAME_COLLAPSED, isCollapsed)
  button.textContent = isCollapsed
    ? '展开'
    : '收起'
}

function collapseStatus(li) {
  const content = select(':scope > .content', li)

  if (!content || content.hasAttribute(ATTRIBUTE_MARKER)) {
    return
  }

  const fullText = normalizeText(content.textContent)

  if (!shouldCollapse(fullText)) {
    return
  }

  const previewText = createPreviewText(fullText)

  if (!previewText) {
    return
  }

  const original = document.createElement('span')
  original.className = CLASSNAME_ORIGINAL

  while (content.firstChild) {
    original.append(content.firstChild)
  }

  const preview = document.createElement('span')
  preview.className = CLASSNAME_PREVIEW
  preview.textContent = previewText

  const toggleButton = document.createElement('button')
  toggleButton.type = 'button'
  toggleButton.className = CLASSNAME_TOGGLE

  content.setAttribute(ATTRIBUTE_MARKER, '')
  content.append(original, preview, toggleButton)
  setCollapsedState(content, toggleButton, true)
}

function restoreStatusContent(content) {
  const original = select(`:scope > .${CLASSNAME_ORIGINAL}`, content)
  const preview = select(`:scope > .${CLASSNAME_PREVIEW}`, content)
  const toggleButton = select(`:scope > .${CLASSNAME_TOGGLE}`, content)

  if (original) {
    while (original.firstChild) {
      content.insertBefore(original.firstChild, original)
    }

    original.remove()
  }

  if (preview) {
    preview.remove()
  }

  if (toggleButton) {
    toggleButton.remove()
  }

  content.classList.remove(CLASSNAME_COLLAPSED)
  content.removeAttribute(ATTRIBUTE_MARKER)
}

function onClickToggle(event) {
  const toggleButton = event.delegateTarget
  const content = toggleButton.closest(`.content[${ATTRIBUTE_MARKER}]`)

  if (!content) {
    return
  }

  const shouldCollapseContent = !content.classList.contains(CLASSNAME_COLLAPSED)
  setCollapsedState(content, toggleButton, shouldCollapseContent)
}

function mutationObserverCallback(mutationRecords) {
  for (const { addedNodes } of mutationRecords) {
    for (const addedNode of addedNodes) {
      if (isStatusElement(addedNode)) {
        collapseStatus(addedNode)
      }
    }
  }
}

function restoreAllStatuses() {
  for (const content of select.all(`.content[${ATTRIBUTE_MARKER}]`)) {
    restoreStatusContent(content)
  }
}

export default context => {
  const { requireModules } = context
  const { timelineElementObserver } = requireModules([ 'timelineElementObserver' ])

  return {
    applyWhen: () => isTimelinePage(),

    onLoad() {
      timelineElementObserver.addCallback(mutationObserverCallback)
      on('click', SELECTOR_TOGGLE, onClickToggle)
    },

    onUnload() {
      timelineElementObserver.removeCallback(mutationObserverCallback)
      off('click', SELECTOR_TOGGLE, onClickToggle)
      restoreAllStatuses()
    },
  }
}
