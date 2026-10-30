import createDirectoryHandleRepository from '../directoryHandleRepository'
import createFileSystemArchiveStore from '../fsStore'
import PersonalArchivePanel from './PersonalArchivePanel'

jest.mock('../directoryHandleRepository', () => jest.fn(() => ({ load: jest.fn() })))
jest.mock('../fsStore', () => jest.fn())
jest.mock('../nostalgiaCache', () => () => ({}))
jest.mock('../fanfouClient', () => () => ({}))
jest.mock('@settings/messaging', () => ({}))

const repository = createDirectoryHandleRepository.mock.results[0].value

function createPanel() {
  const panel = new PersonalArchivePanel()
  panel.setState = update => Object.assign(panel.state, update)
  return panel
}

test('restores a saved directory awaiting permission and loads its metadata after user authorization', async () => {
  const handle = {
    name: 'backup',
    queryPermission: jest.fn().mockResolvedValue('prompt'),
    requestPermission: jest.fn().mockResolvedValue('granted'),
  }
  const readMeta = jest.fn().mockResolvedValue({ counts: { statuses: 3 } })
  repository.load.mockResolvedValue(handle)
  createFileSystemArchiveStore.mockReturnValue({ readMeta })
  const panel = createPanel()

  await panel.restoreDirectory()
  expect(panel.state).toMatchObject({ directoryName: 'backup', permission: 'prompt', meta: null, loading: false })
  expect(readMeta).not.toHaveBeenCalled()

  await panel.handleRestorePermission()
  expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
  expect(panel.state).toMatchObject({ permission: 'granted', meta: { counts: { statuses: 3 } } })
})

test('restores metadata immediately when permission is already granted', async () => {
  repository.load.mockResolvedValue({ name: 'backup', queryPermission: () => Promise.resolve('granted') })
  createFileSystemArchiveStore.mockReturnValue({ readMeta: () => Promise.resolve({ counts: { statuses: 2 } }) })
  const panel = createPanel()
  await panel.restoreDirectory()
  expect(panel.state).toMatchObject({ directoryName: 'backup', permission: 'granted', meta: { counts: { statuses: 2 } } })
})

test('keeps the saved directory visible when metadata cannot be read', async () => {
  repository.load.mockResolvedValue({ name: 'backup', queryPermission: () => Promise.resolve('granted') })
  createFileSystemArchiveStore.mockReturnValue({ readMeta: () => Promise.reject(new Error('read failed')) })
  const panel = createPanel()
  await panel.restoreDirectory()
  expect(panel.state).toMatchObject({ directoryName: 'backup', permission: 'granted', error: 'read failed' })
})
