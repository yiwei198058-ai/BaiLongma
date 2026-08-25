const PLATFORM = process.platform
const IS_WIN = PLATFORM === 'win32'
const IS_MAC = PLATFORM === 'darwin'
const IS_LINUX = PLATFORM === 'linux'

// Windows: 把控制台代码页切到 UTF-8，避免中文 stdout 显示为乱码
if (IS_WIN) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true })
  } catch (_) {}
}

const { app, BrowserWindow, shell, dialog, Menu, ipcMain, Tray, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const http = require('http')
const { EventEmitter } = require('events')
const { pathToFileURL } = require('url')
const { autoUpdater } = require('electron-updater')

const IS_DEV = !app.isPackaged
const WINDOWS_APP_USER_MODEL_ID = 'com.xiaoyuanda.bailongma'
const USER_DIR = app.getPath('userData')
const CODE_ROOT = app.getAppPath()
const RESOURCE_ROOT = CODE_ROOT
const BACKEND_ENTRY = path.join(CODE_ROOT, 'src', 'index.js')

// Voice replies are triggered by SSE events after the user's voice turn. In
// packaged Electron, Chromium can otherwise treat that playback as autoplay and
// reject audioEl.play(), even though the TTS preview path works after a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function getAppIconPath({ trayIcon = false } = {}) {
  if (IS_WIN) return path.join(RESOURCE_ROOT, 'build', 'icon.ico')
  if (IS_MAC) return path.join(RESOURCE_ROOT, 'build', 'icon.png')
  if (IS_LINUX) return path.join(RESOURCE_ROOT, 'build', 'icon.png')
  return path.join(RESOURCE_ROOT, 'build', trayIcon ? 'icon.png' : 'icon.png')
}

// 持久化日志：把 console.* 镜像到 USER_DIR/logs/bailongma.log，
// 安装版没有 stdout 的情况下，卡死/崩溃后还能 tail 这个文件复盘。
// 简易 rotate：> 5MB 时把当前文件改名 .old（覆盖上一份 .old），下次写入重开。
const LOG_DIR = path.join(USER_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'bailongma.log')
const LOG_FILE_OLD = path.join(LOG_DIR, 'bailongma.old.log')
const LOG_MAX_BYTES = 5 * 1024 * 1024
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}
function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size > LOG_MAX_BYTES) {
      try { fs.rmSync(LOG_FILE_OLD, { force: true }) } catch {}
      try { fs.renameSync(LOG_FILE, LOG_FILE_OLD) } catch {}
    }
  } catch {}
}
function writeLog(level, args) {
  let line
  try {
    line = args.map(a => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack || a.message
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' ')
  } catch { line = '[log-serialize-failed]' }
  const ts = new Date().toISOString()
  const out = `${ts} [${level}] ${line}\n`
  try { fs.appendFileSync(LOG_FILE, out) } catch {}
}
// Hijack 一次就够；后端 import 在同一进程，console.* 引用的是同一个 console 对象。
// 把原始方法存起来，appendFile 失败时仍能输出到 stdout/stderr（开发模式可见）。
;(function installLogHijack() {
  const levels = ['log', 'info', 'warn', 'error', 'debug']
  for (const level of levels) {
    const original = console[level]?.bind(console) || (() => {})
    console[level] = (...args) => {
      try { original(...args) } catch {}
      try {
        rotateLogIfNeeded()
        writeLog(level, args)
      } catch {}
    }
  }
})()
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack || reason.message) : String(reason))
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || String(err))
})
process.on('exit', (code) => {
  try { writeLog('log', [`[process] exit code=${code}`]) } catch {}
})
process.on('SIGTERM', () => { console.warn('[process] SIGTERM received') })
process.on('SIGHUP', () => { console.warn('[process] SIGHUP received') })
console.log(`[main] Bailongma ${app.getVersion()} starting, logs → ${LOG_FILE}`)

// ── GPU 适配器偏好（Windows 多显卡：核显 + 独显笔记本） ──
// Windows 的逐应用显卡偏好存在 HKCU\...\DirectX\UserGpuPreferences
// （与系统设置→屏幕→显示卡的逐应用选项同源），这里按 config 替自己的 exe 维护一条：
//   'discrete'=2 高性能（独显） 'integrated'=1 省电（核显） 'system'=删除条目跟随系统（默认）
// config.json 顶级字段 gpuPreference 可改。
//
// 默认跟随系统（= Optimus 上落核显）是实测出来的：v2.1.399 试过默认独显优先，
// MX450 上 3D 只占 9% 却另付 10% 的 copy 引擎过路费——屏幕物理接在核显上，
// 独显画完每帧都要拷回核显显示；且只要有持续动画独显就永远无法断电休眠，
// 薄本上常驻 77°C。点阵球节流/抽稀之后渲染负载核显随手就能扛，独显得不偿失。
// 'discrete' 留作大屏/高分辨率重负载场景的手动开关。
// 该键在 GPU 进程创建 D3D 设备时读取——这里在启动最早期同步写入，
// 但首次变更仍可能晚于 GPU 进程拉起，此时要到下次启动才真正切换适配器。
function applyGpuPreference() {
  if (!IS_WIN) return
  let pref = 'system'
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(USER_DIR, 'config.json'), 'utf-8'))
    if (['discrete', 'integrated', 'system'].includes(cfg?.gpuPreference)) pref = cfg.gpuPreference
  } catch {}
  const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences'
  const { execFileSync } = require('child_process')
  try {
    if (pref === 'system') {
      // 交还系统默认。条目本不存在时 reg 会报错——吞掉即可（结果一样）
      try { execFileSync('reg.exe', ['delete', KEY, '/v', process.execPath, '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
    } else {
      const value = pref === 'integrated' ? 'GpuPreference=1;' : 'GpuPreference=2;'
      execFileSync('reg.exe', ['add', KEY, '/v', process.execPath, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore', windowsHide: true })
    }
    console.log(`[main] GPU 偏好已应用: ${pref}`)
  } catch (e) {
    console.warn('[main] 写入 GPU 偏好失败（不影响启动）:', e.message)
  }
}
applyGpuPreference()

let mainWindow = null
let backendPort = 0
let backendReady = false
let mainWindowPromise = null
let tray = null
let focusBannerWindow = null

// 后端通过 global.focusBannerBridge 控制横幅窗口
const focusBannerBridge = new EventEmitter()
global.focusBannerBridge = focusBannerBridge
global.bailongmaAppControl = {
  restart() {
    console.log('[main] restart requested')
    app.isQuiting = true
    app.relaunch()
    app.quit()
  },
}

if (IS_WIN) {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
}

function sendUpdaterStatus(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('updater:status', {
    currentVersion: app.getVersion(),
    ...payload,
  })
}

async function bootstrapBackend(port) {
  process.env.BAILONGMA_USER_DIR ||= USER_DIR
  process.env.BAILONGMA_RESOURCES_DIR ||= RESOURCE_ROOT
  process.env.BAILONGMA_PORT = String(port)
  await import(pathToFileURL(BACKEND_ENTRY).href)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

async function findFreePort(preferred = 3721) {
  for (const port of [preferred, 0]) {
    try {
      const actual = await new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          server.close(() => resolve(address.port))
        })
      })
      return actual
    } catch {}
  }
  throw new Error('Unable to find a free local port')
}

function waitForBackend(port, timeoutMs = 30000) {
  const startedAt = Date.now()
  const url = `http://127.0.0.1:${port}/activation-status`
  let lastProbe = 'no probe completed'

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Backend startup timed out on port ${port}. Last probe: ${lastProbe}`))
        return
      }

      const req = http.get(url, res => {
        res.resume()
        lastProbe = `HTTP ${res.statusCode || 'unknown'} from ${url}`
        resolve()
      })
      req.on('error', err => {
        lastProbe = err?.message || String(err)
        setTimeout(tick, 300)
      })
      req.setTimeout(1500, () => {
        lastProbe = `timeout waiting for ${url}`
        req.destroy()
        setTimeout(tick, 300)
      })
    }

    tick()
  })
}

function waitForHttpReady(url, timeoutMs = 15000) {
  const startedAt = Date.now()
  let lastProbe = 'no probe completed'

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}. Last probe: ${lastProbe}`))
        return
      }

      const req = http.get(url, res => {
        res.resume()
        lastProbe = `HTTP ${res.statusCode || 'unknown'} from ${url}`
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve()
          return
        }
        setTimeout(tick, 500)
      })
      req.on('error', err => {
        lastProbe = err?.message || String(err)
        setTimeout(tick, 500)
      })
      req.setTimeout(1500, () => {
        lastProbe = `timeout waiting for ${url}`
        req.destroy()
        setTimeout(tick, 500)
      })
    }

    tick()
  })
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  if (mainWindowPromise) return mainWindowPromise
  mainWindowPromise = createWindowOnce().finally(() => {
    mainWindowPromise = null
  })
  return mainWindowPromise
}

async function createWindowOnce() {
  console.log('[main] createWindow start')
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b0e',
    title: 'Bailongma',
    icon: getAppIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  // 授予麦克风权限（语音输入需要）
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') return true
    return false
  })

  // 窗口级快捷键（不用 globalShortcut，避免劫持其他应用的 F11/Ctrl+R 等）
  //   F12      → 切换 DevTools
  //   F11      → 切换全屏
  //   Ctrl+R   → reload（仅 dev）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
      return
    }
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
      event.preventDefault()
      return
    }
    if (IS_DEV && (input.control || input.meta) && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reload()
      event.preventDefault()
      return
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] mainWindow did-finish-load')
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.warn(`[main] mainWindow did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] renderer process gone', details)
  })
  mainWindow.on('unresponsive', () => {
    console.warn('[main] mainWindow unresponsive')
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const source = sourceId ? `${path.basename(sourceId)}:${line || 0}` : `line:${line || 0}`
    console.log(`[renderer:${level}] ${message} (${source})`)
  })

  await loadMainWindowURL()
  console.log('[main] createWindow loaded')
  // Windows/Linux 关闭主窗口时最小化到托盘；macOS 允许销毁窗口，Dock/托盘可重建。
  mainWindow.on('close', (e) => {
    console.log(`[main] mainWindow close isQuiting=${!!app.isQuiting}`)
    if (!app.isQuiting && !IS_MAC) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    console.log('[main] mainWindow closed')
    mainWindow = null
  })

  return mainWindow
}

async function loadMainWindowURL() {
  const url = `http://127.0.0.1:${backendPort}/brain-ui.html`
  const maxAttempts = 20
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await waitForHttpReady(url, 3000)
      await withTimeout(mainWindow.loadURL(url), 8000, `loadURL ${url}`)
      return
    } catch (err) {
      console.warn(`[main] loadURL failed attempt=${attempt}: ${err?.message || err}`)
      try { mainWindow?.webContents?.stop() } catch {}
      if (attempt === maxAttempts) throw err
      await new Promise(resolve => setTimeout(resolve, 700))
    }
  }
}

async function showMainWindow() {
  if (!backendReady) {
    console.log('[main] showMainWindow ignored before backend ready')
    return
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow()
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function setupTray() {
  console.log('[main] setupTray start')
  const trayImage = nativeImage.createFromPath(getAppIconPath({ trayIcon: true }))
  if (IS_MAC) trayImage.setTemplateImage(true)
  tray = new Tray(trayImage)
  tray.setToolTip('Bailongma')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主界面',
      click: () => { showMainWindow().catch(() => {}) },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuiting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => { showMainWindow().catch(() => {}) })
  if (IS_MAC) tray.on('click', () => { showMainWindow().catch(() => {}) })
  console.log('[main] setupTray ready')
}

function createFocusBannerWindow({ task = '', current_step = '', tasks = [] } = {}) {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.webContents.send('focus-banner:update', { task, current_step, tasks })
    return
  }

  const { width: screenW } = require('electron').screen.getPrimaryDisplay().workAreaSize

  focusBannerWindow = new BrowserWindow({
    width: 280,
    height: 60,
    x: Math.round(screenW / 2 - 140),
    y: 48,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    focusable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'focus-banner-preload.cjs'),
    },
  })

  // 给 banner 窗口的 session 也授权麦克风
  focusBannerWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })
  focusBannerWindow.webContents.session.setPermissionCheckHandler((wc, permission) => {
    if (permission === 'media') return true
    return false
  })

  focusBannerWindow.loadFile(path.join(RESOURCE_ROOT, 'focus-banner.html'))

  focusBannerWindow.webContents.once('did-finish-load', () => {
    if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
    // 先发端口配置，让语音识别结果能发回后端
    focusBannerWindow.webContents.send('focus-banner:config', { port: backendPort })
    focusBannerWindow.webContents.send('focus-banner:update', { task, current_step, tasks })
    autoResizeBannerWindow()
  })

  focusBannerWindow.on('closed', () => {
    focusBannerWindow = null
  })
}

function autoResizeBannerWindow() {
  if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
  focusBannerWindow.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('banner')
      return b ? { w: b.offsetWidth, h: b.offsetHeight } : null
    })()
  `).then(size => {
    if (!size || !focusBannerWindow || focusBannerWindow.isDestroyed()) return
    const padW = 0
    const padH = 0
    focusBannerWindow.setSize(Math.max(160, size.w + padW), Math.max(40, size.h + padH))
  }).catch(() => {})
}

// Focus Banner IPC handlers
ipcMain.on('focus-banner:close', () => {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.close()
    focusBannerWindow = null
  }
})

ipcMain.on('focus-banner:set-expanded', (_e, { expanded }) => {
  if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
  setTimeout(() => autoResizeBannerWindow(), 50)
})

ipcMain.on('focus-banner:request-resize', () => {
  setTimeout(() => autoResizeBannerWindow(), 30)
})

ipcMain.on('focus-banner:toggle-task', (_e, { idx, done }) => {
  // 任务勾选状态更改，横幅已在前端自行更新，无需额外操作
})

// 后端 bridge 事件监听
focusBannerBridge.on('command', ({ action, task, current_step, tasks }) => {
  if (action === 'show' || action === 'update') {
    createFocusBannerWindow({ task, current_step, tasks })
  }
})

focusBannerBridge.on('hide', () => {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.close()
    focusBannerWindow = null
  }
})

function setupAutoUpdater() {
  autoUpdater.autoDownload = false
  // Avoid applying an already downloaded update while Windows is shutting down.
  // The renderer still installs explicitly through updater:quit-and-install.
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterStatus({ stage: 'checking' })
  })

  autoUpdater.on('update-available', info => {
    console.log('[updater] update available', info?.version)
    sendUpdaterStatus({ stage: 'available', version: info?.version })
  })

  autoUpdater.on('download-progress', progress => {
    sendUpdaterStatus({
      stage: 'downloading',
      percent: Number(progress?.percent || 0),
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
    })
  })

  autoUpdater.on('update-downloaded', info => {
    console.log('[updater] update downloaded', info?.version)
    sendUpdaterStatus({ stage: 'downloaded', version: info?.version })
  })

  autoUpdater.on('update-not-available', info => {
    sendUpdaterStatus({
      stage: 'up-to-date',
      version: info?.version || app.getVersion(),
    })
  })

  autoUpdater.on('error', err => {
    const message = err?.message || String(err || 'Update failed')
    console.warn('[updater] update failed', message)
    sendUpdaterStatus({ stage: 'error', message })
  })

  if (!IS_DEV && process.env.BAILONGMA_AUTO_CHECK_UPDATES === '1') {
    autoUpdater.checkForUpdates().catch(err => {
      // 不要静默吞掉更新检查失败。GitHub 在国内经常超时/不可达，若整段吞掉，
      // 用户会卡在「永远没有更新」且无任何痕迹。这里至少落到日志，便于排查。
      console.warn('[updater] initial check failed', err?.message || err)
    })
  }
}

ipcMain.handle('app:get-version', () => app.getVersion())

ipcMain.handle('updater:check-for-updates', async () => {
  if (IS_DEV) {
    sendUpdaterStatus({ stage: 'dev' })
    return { ok: false, skipped: true, reason: 'dev' }
  }
  try {
    sendUpdaterStatus({ stage: 'checking' })
    const result = await autoUpdater.checkForUpdates()
    return { ok: true, updateInfo: result?.updateInfo || null }
  } catch (error) {
    const message = error?.message || String(error || 'Update check failed')
    sendUpdaterStatus({ stage: 'error', message })
    return { ok: false, message }
  }
})

ipcMain.handle('updater:start-download', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (error) {
    const message = error?.message || String(error || 'Download failed')
    sendUpdaterStatus({ stage: 'error', message })
    return { ok: false, message }
  }
})

ipcMain.handle('updater:quit-and-install', () => {
  autoUpdater.quitAndInstall()
})

app.on('second-instance', () => {
  console.log('[main] second-instance')
  showMainWindow().catch(() => {})
})

app.on('activate', () => {
  console.log('[main] activate')
  if (IS_MAC) showMainWindow().catch(() => {})
})

app.on('window-all-closed', () => {
  console.log('[main] window-all-closed')
  // 主窗口关闭后保持后台运行（Focus Banner 等桌面功能继续工作）
  // 只有托盘菜单「退出」才真正退出
})

app.on('before-quit', () => {
  console.log('[main] before-quit')
  app.isQuiting = true
})

app.on('will-quit', () => {
  console.log('[main] will-quit')
})

app.on('quit', (_event, code) => {
  console.log(`[main] quit code=${code}`)
})

app.whenReady().then(async () => {
  console.log('[main] app ready')
  Menu.setApplicationMenu(null)

  try {
    backendPort = await findFreePort(3721)
    console.log(`[main] bootstrapBackend port=${backendPort}`)
    await bootstrapBackend(backendPort)
    console.log('[main] waitForBackend start')
    await waitForBackend(backendPort)
    backendReady = true
    console.log('[main] waitForBackend done')
  } catch (err) {
    console.error(`[main] Backend startup failed on port ${backendPort || 'unknown'}`, err?.stack || err?.message || err)
    dialog.showErrorBox('Startup failed', `Unable to start the Bailongma backend:\n${err.message}`)
    app.quit()
    return
  }

  try {
    await createWindow()
  } catch (err) {
    console.error('[main] createWindow failed', err?.stack || err?.message || err)
    dialog.showErrorBox('Startup warning', `Bailongma backend is running, but the main window did not load:\n${err.message}`)
  }
  setupTray()
  setupAutoUpdater()
  console.log('[main] app startup complete')
  // 不再注册任何系统级 globalShortcut；F11 / F12 / Ctrl+R 已由 mainWindow
  // 的 before-input-event 处理（见 createWindow），只在窗口获焦时生效，
  // 不会劫持浏览器/IDE 等其他应用的同键操作。
})
