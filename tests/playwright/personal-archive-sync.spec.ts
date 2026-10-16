import fs from 'node:fs'
import path from 'node:path'
import { chromium, expect, test } from '@playwright/test'

test('unfinished favorites allow new-message sync and keep their resume cursor after reload', async () => {
  const extensionPath = path.resolve(__dirname, '../../dist')
  fs.mkdirSync('test-results', { recursive: true })
  const profile = fs.mkdtempSync(path.resolve('test-results/archive-sync-profile-'))
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [ `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox' ],
  })

  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
    const extensionId = worker.url().split('/')[2]
    // Only OAuth/API messages use fixture responses. Settings still use the real worker.
    await context.addInitScript(() => {
      if (!location.href.startsWith('chrome-extension://')) return
      const runtime = (window as any).chrome.runtime
      const connect = runtime.connect.bind(runtime)
      runtime.connect = (...args: any[]) => {
        const port = connect(...args)
        const listeners: any[] = []
        return {
          onDisconnect: port.onDisconnect,
          onMessage: {
            addListener(listener: any) {
              listeners.push(listener)
              port.onMessage.addListener(listener)
            },
          },
          postMessage(envelope: any) {
            const { action, payload } = envelope.message
            let message: any
            if (action === 'FANFOU_OAUTH_GET_STATUS') {
              message = { status: { hasTokens: true, userId: 'fixture-account', screenName: '测试账号' } }
            } else if (action === 'FANFOU_OAUTH_API_REQUEST') {
              const requests = (window as any).archiveRequests || []
              requests.push({ url: payload.url, query: payload.query })
              ;(window as any).archiveRequests = requests
              message = {
                responseJSON: payload.url.endsWith('/users/show.json')
                  ? { id: 'fixture-account', name: '测试账号' } : [],
              }
            } else {
              port.postMessage(envelope)
              return
            }
            setTimeout(() => listeners.forEach(listener => listener({ senderId: envelope.senderId, message })), 150)
          },
        }
      }
    })

    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/settings.html#personal-archive`)
    await expect(page.getByRole('button', { name: '选择备份文件夹', exact: true })).toBeVisible()
    // Use a real, isolated OPFS directory and a serializable handle. No personal backup is accessed.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle('test-backup', { create: true })
      const file = await directory.getFileHandle('meta.json', { create: true })
      const writable = await file.createWritable()
      await writable.write(JSON.stringify({
        schemaVersion: 1, archiveTimezone: 'Asia/Shanghai',
        account: { id: 'fixture-account', name: '测试账号' },
        counts: { statuses: 1, favorites: 71 },
        shards: { statuses: {}, favorites: {} },
        watermark: { statuses: { newestId: 'old-message', reachedFirstEver: true } },
        activeRun: { resource: 'favorites', mode: 'backfill', nextMaxId: 'saved-favorite', committedPages: 2 },
      }))
      await writable.close()
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('space-fanfou-personal-archive', 1)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction('directory-handles', 'readwrite')
          transaction.objectStore('directory-handles').put(directory, 'active')
          transaction.oncomplete = () => { database.close(); resolve() }
          transaction.onerror = () => reject(transaction.error)
        }
        request.onerror = () => reject(request.error)
      })
    })
    await page.reload()

    const sync = page.getByRole('button', { name: '同步新消息', exact: true })
    const favorites = page.getByRole('button', { name: '继续收藏同步', exact: true })
    await expect(sync).toBeEnabled()
    await expect(favorites).toBeEnabled()
    await expect(page.getByRole('button', { name: '同步收到的提及', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '备份私信', exact: true })).toBeEnabled()
    await sync.click()
    await expect(favorites).toBeDisabled()
    await expect(page.getByText('本轮同步完成，共 1 条。', { exact: true })).toBeVisible()

    const readMeta = () => page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle('test-backup')
      const file = await (await directory.getFileHandle('meta.json')).getFile()
      return JSON.parse(await file.text())
    })
    const saved = await readMeta()
    expect(saved.activeRun).toBeNull()
    expect(saved.pendingRuns.favorites).toMatchObject({ nextMaxId: 'saved-favorite', committedPages: 2 })
    await page.reload()
    await expect(sync).toBeEnabled()
    await expect(favorites).toBeEnabled()
    await favorites.click()
    await expect(page.getByText('本轮同步完成，共 71 条。', { exact: true })).toBeVisible()
    const queries = await page.evaluate(() => (window as any).archiveRequests)
    expect(queries.find((request: any) => request.url.endsWith('/favorites/id.json')).query.max_id).toBe('saved-favorite')
    const completed = await readMeta()
    expect(completed.activeRun).toBeNull()
    expect(completed.pendingRuns.favorites).toBeUndefined()
  } finally {
    await context.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
