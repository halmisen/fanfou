import PersonalArchivePanel from './PersonalArchivePanel'

jest.mock('@settings/messaging', () => ({ postMessage: jest.fn() }))

function buttonsIn(node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.reduce((buttons, child) => buttons.concat(buttonsIn(child)), [])
  const children = buttonsIn(node.props?.children)
  return node.type === 'button' ? [ node, ...children ] : children
}

test('popup offers a tab handoff without directory or sync actions', () => {
  const panel = new PersonalArchivePanel()
  panel.state = { ...panel.state, loading: false, isPopup: true, directoryName: 'backup' }

  const buttons = buttonsIn(panel.render())

  expect(buttons).toHaveLength(1)
  expect(buttons[0].props.onClick).toBe(panel.handleOpenInTab)
})

test('tab retains the directory, sync and archive actions', () => {
  const panel = new PersonalArchivePanel()
  panel.state = { ...panel.state, loading: false, isPopup: false, directoryName: 'backup' }

  const handlers = buttonsIn(panel.render()).map(button => button.props.onClick)

  expect(handlers).toEqual([
    panel.handleChooseDirectory,
    panel.handleStartSync,
    panel.handlePause,
    panel.handleDownloadMedia,
    panel.handleBuildOffline,
  ])
})
