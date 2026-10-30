import fs from 'node:fs'
import path from 'node:path'
import { chromium, expect, test } from '@playwright/test'

test('saved directory remains visible when permission must be requested again', async () => {
  const extensionPath = path.resolve(__dirname, '../../dist')
  fs.mkdirSync('test-results', { recursive: true })
  const profile = fs.mkdtempSync(path.resolve('test-results/archive-permission-profile-'))
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [ `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox' ],
  })
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
    const extensionId = worker.url().split('/')[2]
    await context.addInitScript(() => {
      if (!location.href.startsWith('chrome-extension://')) return
      const prototype = FileSystemHandle.prototype
      prototype.queryPermission = async () => sessionStorage.getItem('archive-granted') ? 'granted' : 'prompt'
      prototype.requestPermission = async () => { sessionStorage.setItem('archive-granted', 'yes'); return 'granted' }
    })
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/settings.html#personal-archive`)
    await expect(page.getByRole('button', { name: '选择备份文件夹', exact: true })).toBeVisible()
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle('fixture-backup', { create: true })
      const file = await directory.getFileHandle('meta.json', { create: true })
      const writable = await file.createWritable()
      await writable.write(JSON.stringify({ counts: { statuses: 3 } }))
      await writable.close()
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('space-fanfou-personal-archive', 1)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('directory-handles', 'readwrite')
          tx.objectStore('directory-handles').put(directory, 'active')
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => reject(tx.error)
        }
        request.onerror = () => reject(request.error)
      })
    })
    await page.reload()
    await expect(page.getByText('备份文件夹：fixture-backup（权限：需要确认）')).toBeVisible()
    await page.getByRole('button', { name: '授权访问备份文件夹' }).click()
    await expect(page.getByText('备份文件夹：fixture-backup（权限：已允许）')).toBeVisible()
    await expect(page.getByText('已落盘消息：3 条')).toBeVisible()
  } finally {
    await context.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
