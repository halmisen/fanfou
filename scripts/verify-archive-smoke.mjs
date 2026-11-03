#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const extensionPath = path.resolve(rootDir, 'dist')

const args = process.argv.slice(2)
const isJson = args.includes('--json')
const isDoctorOnly = args.includes('doctor')
const injectFailStage1 = args.includes('--inject-fail-stage-1')
const injectFailStage2 = args.includes('--inject-fail-stage-2')
const injectFailStage3 = args.includes('--inject-fail-stage-3')

// Exit Code mapping:
// 0: All stages passed
// 1: Prerequisites / environment missing (dist not found, etc.)
// 2: Stage 1 failed (Page initialization / blank screen / pageerror)
// 3: Stage 2 failed (SW protocol handshake failure / timeout / __isError)
// 4: Stage 3 failed (Permission & data binding state machine failure)
// 5: Script internal error or bad arguments

const report = {
  ok: false,
  exit_code: 5,
  stages: {
    prerequisites: { status: 'pending' },
    page_initialization: { status: 'not_run' },
    sw_handshake: { status: 'not_run' },
    permission_and_data: { status: 'not_run' },
  },
  total_elapsed_ms: 0,
}

const startTime = Date.now()

function finalize(exitCode, failedStage = null, errorMessage = null) {
  report.exit_code = exitCode
  report.ok = exitCode === 0
  report.total_elapsed_ms = Date.now() - startTime
  if (failedStage) {
    report.failed_stage = failedStage
    report.stages[failedStage] = {
      status: 'fail',
      error: errorMessage,
    }
  }

  if (isJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    if (report.ok) {
      console.log(`[PASS] archive-settings-smoke passed all stages (${report.total_elapsed_ms}ms)`)
    } else {
      console.error(`[FAIL] archive-settings-smoke failed at stage: ${report.failed_stage || 'unknown'} (exit ${exitCode})`)
      if (errorMessage) {
        console.error(`Error: ${errorMessage}`)
      }
    }
  }
  process.exit(exitCode)
}

process.on('uncaughtException', err => {
  finalize(5, 'script_internal', err.stack || err.message)
})

async function run() {
  // --- Check Prerequisites (Stage: Prerequisites, exit 1 if failed) ---
  const manifestPath = path.join(extensionPath, 'manifest.json')
  const settingsHtmlPath = path.join(extensionPath, 'settings.html')
  const backgroundJsPath = path.join(extensionPath, 'background.js')

  if (!fs.existsSync(extensionPath) || !fs.existsSync(manifestPath) || !fs.existsSync(settingsHtmlPath) || !fs.existsSync(backgroundJsPath)) {
    report.stages.prerequisites = {
      status: 'fail',
      error: 'Extension build directory dist/ or required entry assets (manifest.json, settings.html, background.js) not found. Run `npm run build` first.',
    }
    finalize(1, 'prerequisites', report.stages.prerequisites.error)
    return
  }

  let buildMtime = 'unknown'
  try {
    const stat = fs.statSync(manifestPath)
    buildMtime = stat.mtime.toISOString()
  } catch (e) {
    // Ignore error
  }

  report.stages.prerequisites = {
    status: 'pass',
    dist_path: extensionPath,
    build_mtime: buildMtime,
  }

  if (isDoctorOnly) {
    finalize(0)
    return
  }

  // --- Run Smoke Pipeline ---
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-smoke-profile-'))

  let context
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
      ],
    })

    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 })
    const extensionId = worker.url().split('/')[2]

    // Inject mock file system handlers and test hooks
    await context.addInitScript(({ injectFailStage1, injectFailStage2, injectFailStage3 }) => {
      if (!location.href.startsWith('chrome-extension://')) return

      if (injectFailStage1) {
        // Intentionally trigger unhandled page error to simulate Lesson 29 white-screen
        setTimeout(() => {
          throw new TypeError('Smoke injected fault: Cannot read properties of undefined (reading \'options\')')
        }, 10)
      }

      const prototype = FileSystemHandle.prototype
      prototype.queryPermission = async () => sessionStorage.getItem('archive-granted') ? 'granted' : 'prompt'
      prototype.requestPermission = async () => {
        if (injectFailStage3) {
          // Intentionally break contract: permission granted but UI state simulation breaks
          return 'denied'
        }
        sessionStorage.setItem('archive-granted', 'yes')
        return 'granted'
      }

      if (injectFailStage2) {
        window.__SMOKE_INJECT_SW_FAIL__ = true
      }
    }, { injectFailStage1, injectFailStage2, injectFailStage3 })

    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', err => {
      pageErrors.push(err.message || String(err))
    })

    // --- Stage 1: Page Initialization (exit 2 if failed) ---
    const stage1Start = Date.now()
    report.stages.page_initialization.status = 'running'

    try {
      await page.goto(`chrome-extension://${extensionId}/settings.html#personal-archive`, {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      })

      // Wait for app container to be populated
      await page.waitForSelector('#app', { timeout: 8000 })

      // Check if any fatal pageerror occurred during boot
      if (pageErrors.length > 0) {
        throw new Error(`Page error detected during initialization: ${pageErrors.join('; ')}`)
      }

      // Assert that either the choose directory button or personal-archive panel rendered
      const button = page.getByRole('button', { name: '选择备份文件夹', exact: true })
      await button.waitFor({ state: 'visible', timeout: 8000 })

      report.stages.page_initialization = {
        status: 'pass',
        elapsed_ms: Date.now() - stage1Start,
      }
    } catch (err) {
      finalize(2, 'page_initialization', err.message)
      return
    }

    // --- Stage 2: Service Worker Protocol Handshake (exit 3 if failed) ---
    const stage2Start = Date.now()
    report.stages.sw_handshake.status = 'running'

    try {
      const handshakeResult = await page.evaluate(async () => {
        if (window.__SMOKE_INJECT_SW_FAIL__) {
          // Simulate Port disconnection or communication failure
          return { error: 'Injected Port disconnection / timeout' }
        }

        return new Promise(resolve => {
          try {
            const port = chrome.runtime.connect({ name: 'archive-smoke-probe' })
            const senderId = 'smoke-' + Math.random().toString(36).slice(2)
            const timeout = setTimeout(() => {
              resolve({ error: 'SW handshake timeout after 5000ms' })
            }, 5000)

            port.onMessage.addListener(response => {
              if (response && response.senderId === senderId) {
                clearTimeout(timeout)
                resolve({ success: true, message: response.message })
              }
            })

            port.postMessage({
              senderId,
              message: {
                action: 'FANFOU_OAUTH_GET_STATUS',
                payload: {},
              },
            })
          } catch (e) {
            resolve({ error: e.message })
          }
        })
      })

      if (handshakeResult.error) {
        throw new Error(`Background SW handshake failed: ${handshakeResult.error}`)
      }

      const msg = handshakeResult.message
      if (msg && msg.__isError) {
        throw new Error(`Background SW returned error response: ${msg.message || JSON.stringify(msg)}`)
      }

      if (!msg || typeof msg !== 'object') {
        throw new Error(`Background SW response malformed or missing expected payload`)
      }

      report.stages.sw_handshake = {
        status: 'pass',
        elapsed_ms: Date.now() - stage2Start,
      }
    } catch (err) {
      finalize(3, 'sw_handshake', err.message)
      return
    }

    // --- Stage 3: Permission & Data Binding State Machine (exit 4 if failed) ---
    const stage3Start = Date.now()
    report.stages.permission_and_data.status = 'running'

    try {
      // Seed OPFS directory and IndexedDB handle
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const directory = await root.getDirectoryHandle('fixture-backup', { create: true })
        const file = await directory.getFileHandle('meta.json', { create: true })
        const writable = await file.createWritable()
        await writable.write(JSON.stringify({ counts: { statuses: 3 } }))
        await writable.close()

        await new Promise((resolve, reject) => {
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

      // Reload to let directoryHandleRepository pick up the newly active handle
      await page.reload({ waitUntil: 'domcontentloaded' })

      // Verify negative/prompt state before approval
      const statusPrompt = page.getByText('备份文件夹：fixture-backup（权限：需要确认）')
      await statusPrompt.waitFor({ state: 'visible', timeout: 8000 })

      // Trigger permission grant button
      const authButton = page.getByRole('button', { name: '授权访问备份文件夹' })
      await authButton.waitFor({ state: 'visible', timeout: 5000 })
      await authButton.click()

      // Assert transition to granted state
      const statusGranted = page.getByText('备份文件夹：fixture-backup（权限：已允许）')
      await statusGranted.waitFor({ state: 'visible', timeout: 8000 })

      // Assert data binding correctly rendered status counts from meta.json
      const countLabel = page.getByText('已落盘消息：3 条')
      await countLabel.waitFor({ state: 'visible', timeout: 8000 })

      report.stages.permission_and_data = {
        status: 'pass',
        elapsed_ms: Date.now() - stage3Start,
      }
    } catch (err) {
      finalize(4, 'permission_and_data', err.message)
      return
    }

    // All stages succeeded!
    finalize(0)
  } finally {
    if (context) {
      await context.close().catch(() => {})
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch (e) {
      // Ignore cleanup error
    }
  }
}

run().catch(err => {
  finalize(5, 'script_internal', err.stack || err.message)
})
