const { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { execFile } = require('node:child_process')

const DEFAULT_SHELL = 'C:\\Users\\Yua\\apps\\napcat\\shell'
const ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico')
const SPLASH_HTML = path.join(__dirname, 'splash.html')
const PRELOAD = path.join(__dirname, 'preload.js')

let mainWindow = null
let splashWindow = null
let tray = null
let quitting = false

function logLine(...parts) {
  try {
    const file = path.join(app.getPath('userData'), 'app.log')
    fs.appendFileSync(file, `${new Date().toISOString()} ${parts.join(' ')}\n`)
  } catch {
    /* ignore */
  }
}

/* ---------------- settings ---------------- */

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (e) {
    console.error('save settings failed:', e)
  }
  return next
}

function shellPath() {
  const s = loadSettings()
  if (s.shellPath && fs.existsSync(path.join(s.shellPath, 'napcat.mjs'))) return s.shellPath
  if (fs.existsSync(path.join(DEFAULT_SHELL, 'napcat.mjs'))) return DEFAULT_SHELL
  return s.shellPath || DEFAULT_SHELL
}

/* ---------------- napcat helpers ---------------- */

function readWebuiConfig(base) {
  const file = path.join(base, 'config', 'webui.json')
  const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')
  const raw = JSON.parse(text)
  const host = String(raw.host || '127.0.0.1')
  const port = Number(raw.port) || 6099
  const token = String(raw.token || '')
  const connectHost = host === '::' || host === '0.0.0.0' ? '127.0.0.1' : host
  return { host: connectHost, port, token }
}

/**
 * 桌面端接管 WebUI token：启动 NapCat 时通过 NAPCAT_WEBUI_SECRET_KEY 注入，
 * 保证「配置文件 token == 运行实例 token」，避免登录页反复出现。
 */
function effectiveToken(base) {
  const s = loadSettings()
  if (s.token) return s.token
  let token = ''
  try {
    token = readWebuiConfig(base).token
  } catch {
    /* ignore */
  }
  if (!token) token = 'napcat'
  saveSettings({ token })
  return token
}

function probe(port, timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout },
      (res) => {
        res.resume()
        resolve(true)
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

function webuiUrl(cfg, token) {
  return `http://${cfg.host}:${cfg.port}/webui${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

function resolveQQPath() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      [
        'query',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
        '/v',
        'UninstallString',
      ],
      { windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const m = stdout.match(/REG_SZ\s+(.+)/)
        if (!m) return resolve(null)
        const uninstall = m[1].trim().replace(/^"|"$/g, '')
        const dir = path.win32.dirname(uninstall)
        const qq = path.win32.join(dir, 'QQ.exe')
        resolve(fs.existsSync(qq) ? qq : null)
      }
    )
  })
}

/**
 * 以管理员身份静默启动 NapCat（注入 QQ）。返回 { ok, error }
 */
function startNapCat(base, qqPath, token) {
  return new Promise((resolve) => {
    const exe = path.join(base, 'NapCatWinBootMain.exe')
    const hook = path.join(base, 'NapCatWinBootHook.dll')
    if (!fs.existsSync(exe)) {
      return resolve({ ok: false, error: `未找到 NapCatWinBootMain.exe：${exe}` })
    }
    if (!qqPath) {
      return resolve({ ok: false, error: '未在注册表中找到 QQ 安装路径，请确认 QQ 已正确安装' })
    }
    const ps = [
      `$env:NAPCAT_PATCH_PACKAGE='${path.join(base, 'qqnt.json')}'`,
      `$env:NAPCAT_LOAD_PATH='${path.join(base, 'loadNapCat.js')}'`,
      `$env:NAPCAT_INJECT_PATH='${hook}'`,
      `$env:NAPCAT_LAUNCHER_PATH='${exe}'`,
      `$env:NAPCAT_MAIN_PATH='${path.join(base, 'napcat.mjs')}'`,
      token ? `$env:NAPCAT_WEBUI_SECRET_KEY='${token}'` : '',
      `Start-Process -FilePath '${exe}' -ArgumentList '${qqPath}','${hook}' -WorkingDirectory '${base}' -Verb RunAs -WindowStyle Hidden`,
    ]
      .filter(Boolean)
      .join('; ')

    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          const cancelled = /cancell?ed|1312|操作已被取消/i.test(`${stderr} ${err.message}`)
          return resolve({
            ok: false,
            error: cancelled
              ? '已取消管理员授权（NapCat 需要管理员权限注入 QQ）'
              : `启动失败：${stderr || err.message}`,
          })
        }
        resolve({ ok: true })
      }
    )
  })
}

/* ---------------- windows ---------------- */

function setSplashStatus(text, sub) {
  if (!splashWindow || splashWindow.isDestroyed()) return
  splashWindow.webContents.send('status', { text, sub: sub || '' })
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 280,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0b0d12',
    icon: ICON_ICO,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  })
  splashWindow.loadFile(SPLASH_HTML)
  splashWindow.once('ready-to-show', () => splashWindow.show())
}

function createMainWindow(url) {
  const s = loadSettings()
  const bounds = s.windowBounds || {}
  mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 820,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#111318',
    title: 'NapCat',
    icon: ICON_ICO,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  })

  mainWindow.loadURL(url)

  if (process.env.NAPCAT_DEBUG) {
    const logFile = path.join(__dirname, '..', 'debug-window.log')
    const write = (line) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    write(`loadURL ${url.replace(/token=[^&]+/, 'token=***')}`)
    mainWindow.webContents.on('console-message', (_e, level, message) => write(`[console:${level}] ${message}`))
    mainWindow.webContents.on('did-finish-load', async () => {
      const href = await mainWindow.webContents.executeJavaScript('location.href').catch(() => '?')
      const title = await mainWindow.webContents.executeJavaScript('document.title').catch(() => '?')
      write(`did-finish-load href=${href.replace(/token=[^&]+/, 'token=***')} title=${title}`)
    })
    mainWindow.webContents.on('did-navigate', (_e, target) => write(`did-navigate ${target.replace(/token=[^&]+/, 'token=***')}`))
  }
  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
    splashWindow = null
    mainWindow.show()
  })

  mainWindow.on('close', () => {
    if (!mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      const b = mainWindow.getBounds()
      saveSettings({ windowBounds: b })
    }
  })

  mainWindow.on('closed', () => {
    logLine('main window closed')
    mainWindow = null
  })
  mainWindow.webContents.on('did-finish-load', () => logLine('did-finish-load'))
  mainWindow.webContents.on('render-process-gone', (_e, d) => logLine('render gone', JSON.stringify(d)))

  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      checkLoginState()
    }, 3500)
    if (process.argv.includes('--shot')) {
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage()
          fs.writeFileSync(path.join(__dirname, '..', 'preview.png'), img.toPNG())
          logLine('screenshot saved')
        } catch (e) {
          logLine('screenshot failed', String(e))
        }
        app.quit()
      }, 6000)
    }
  })

  // 站内链接外部打开（避免 WebUI 被导航走）
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return // aborted
    setSplashStatus('页面加载失败', `${desc} (${code})`)
  })
}

function showMain() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  boot()
}

/* ---------------- boot flow ---------------- */

async function waitForWebui(port, timeoutMs = 180000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await probe(port)) return true
    await new Promise((r) => setTimeout(r, 1200))
  }
  return false
}

async function boot() {
  const base = shellPath()
  logLine('boot: shellPath=', base)
  let cfg
  try {
    cfg = readWebuiConfig(base)
  } catch (e) {
    dialog.showErrorBox(
      '配置读取失败',
      `无法读取 ${path.join(base, 'config', 'webui.json')}\n\n${e.message}\n\n请在设置中确认 NapCat 目录是否正确。`
    )
    return
  }

  const token = effectiveToken(base)

  logLine('boot: cfg port=', cfg.port, 'tokenLen=', String(token).length)
  if (await probe(cfg.port)) {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
    splashWindow = null
    logLine('boot: webui already up')
    createMainWindow(webuiUrl(cfg, token))
    return
  }

  createSplash()
  setSplashStatus('正在启动 NapCat…', '需要管理员权限注入 QQ，请在弹窗中确认')

  const qqPath = await resolveQQPath()
  const result = await startNapCat(base, qqPath, token)
  if (!result.ok) {
    setSplashStatus('启动失败', result.error)
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'NapCat 启动失败',
      message: result.error,
      detail: '你可以手动启动 NapCat 后再点「重试」，或先检查 QQ 是否已安装。',
      buttons: ['重试', '打开 NapCat 目录', '退出'],
      defaultId: 0,
      cancelId: 2,
    })
    if (choice === 1) shell.openPath(base)
    if (choice === 0) {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
      splashWindow = null
      return boot()
    }
    app.quit()
    return
  }

  setSplashStatus('等待 WebUI 就绪…', 'QQ 首次启动可能需要 20~60 秒')

  const ready = await waitForWebui(cfg.port)
  if (!ready) {
    setSplashStatus('等待超时', 'NapCat 未在 3 分钟内开放 WebUI 端口')
    dialog.showErrorBox(
      '等待超时',
      'NapCat 未在 3 分钟内启动完成。\n\n请检查：\n1. QQ 是否被其它账号占用（同一账号不能重复登录）\n2. 是否已通过管理员授权\n3. NapCat 日志目录中的最新日志'
    )
    app.quit()
    return
  }

  createMainWindow(webuiUrl(cfg, token))
}

/* ---------------- menu / tray ---------------- */

function currentUrl() {
  try {
    const base = shellPath()
    return webuiUrl(readWebuiConfig(base), effectiveToken(base))
  } catch {
    return ''
  }
}

/** 页面落到登录页时提示：说明运行实例的 token 与桌面端接管的不一致 */
async function checkLoginState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const p = await mainWindow.webContents
    .executeJavaScript('location.pathname + location.search')
    .catch(() => '')
  logLine('checkLoginState path=', p)
  if (!p.includes('web_login')) return
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: '需要接管登录凭证',
    message: '当前运行的 NapCat 使用的是旧 WebUI 密码，桌面端无法自动登录。',
    detail:
      '点「重启 NapCat」后，桌面端会用自己的凭证重新拉起 QQ 与 NapCat，之后每次都能直接进入面板（需要确认一次管理员授权）。',
    buttons: ['重启 NapCat（推荐）', '暂时忽略'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice === 0) restartNapCat()
}

function restartNapCat() {
  const base = shellPath()
  const token = effectiveToken(base)
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: '重启 NapCat',
    message: '将关闭当前登录的 QQ 进程并重新启动 NapCat，确定继续吗？',
    detail: '重启后 WebUI 登录凭证将由桌面端统一接管，需要确认一次管理员授权。',
    buttons: ['取消', '重启'],
    defaultId: 1,
    cancelId: 0,
  })
  if (choice !== 1) return

  const exe = path.join(base, 'NapCatWinBootMain.exe')
  const hook = path.join(base, 'NapCatWinBootHook.dll')

  resolveQQPath().then((qqPath) => {
    if (!qqPath) {
      dialog.showErrorBox('无法重启', '未在注册表中找到 QQ 安装路径。')
      return
    }
    const script = [
      'Stop-Process -Name QQ -Force -ErrorAction SilentlyContinue',
      'Start-Sleep -Milliseconds 1200',
      `$env:NAPCAT_PATCH_PACKAGE='${path.join(base, 'qqnt.json')}'`,
      `$env:NAPCAT_LOAD_PATH='${path.join(base, 'loadNapCat.js')}'`,
      `$env:NAPCAT_INJECT_PATH='${hook}'`,
      `$env:NAPCAT_LAUNCHER_PATH='${exe}'`,
      `$env:NAPCAT_MAIN_PATH='${path.join(base, 'napcat.mjs')}'`,
      `$env:NAPCAT_WEBUI_SECRET_KEY='${token}'`,
      `Start-Process -FilePath '${exe}' -ArgumentList '${qqPath}','${hook}' -WorkingDirectory '${base}' -Verb RunAs -WindowStyle Hidden`,
    ].join('; ')

    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
      async (err, _out, stderr) => {
        if (err) {
          const cancelled = /cancell?ed|1312|操作已被取消/i.test(`${stderr} ${err.message}`)
          dialog.showErrorBox(
            '重启失败',
            cancelled ? '已取消管理员授权，NapCat 未重启。' : `重启失败：${stderr || err.message}`
          )
          return
        }
        if (mainWindow) {
          const cfg = readWebuiConfig(base)
          mainWindow.loadURL(webuiUrl(cfg, token))
        }
      }
    )
  })
}

function buildMenu() {
  const template = [
    {
      label: '页面',
      submenu: [
        { label: '重新加载', accelerator: 'F5', click: () => mainWindow && mainWindow.reload() },
        { label: '强制重载', accelerator: 'CmdOrCtrl+F5', click: () => mainWindow && mainWindow.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: '在浏览器中打开', click: () => shell.openExternal(currentUrl()) },
        { label: '复制 WebUI 链接', click: () => require('electron').clipboard.writeText(currentUrl()) },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: 'NapCat',
      submenu: [
        { label: '启动 / 重启 NapCat', click: restartNapCat },
        { type: 'separator' },
        { label: '打开 NapCat 目录', click: () => shell.openPath(shellPath()) },
        { label: '打开配置目录', click: () => shell.openPath(path.join(shellPath(), 'config')) },
        { label: '打开日志目录', click: () => shell.openPath(path.join(shellPath(), 'logs')) },
        { type: 'separator' },
        {
          label: '设置 NapCat 目录…',
          click: async () => {
            const res = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择 NapCat 所在目录（含 napcat.mjs）' })
            if (res.canceled || !res.filePaths.length) return
            saveSettings({ shellPath: res.filePaths[0] })
            dialog.showMessageBoxSync({ type: 'info', message: '目录已保存，重启应用后生效。', buttons: ['好'] })
          },
        },
        { type: 'separator' },
        { label: '关于', click: () => dialog.showMessageBoxSync({ type: 'info', title: 'NapCat Desktop', message: 'NapCat Desktop 1.0.0', detail: 'NapCat WebUI 的桌面客户端：自动拉起 NapCat、内嵌 WebUI、托盘常驻。', buttons: ['好'], icon: ICON_ICO }) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON_ICO)
    tray = new Tray(img.resize({ width: 16, height: 16 }))
    tray.setToolTip('NapCat')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开面板', click: showMain },
        { label: '重新加载', click: () => mainWindow && mainWindow.reload() },
        { type: 'separator' },
        { label: '启动 / 重启 NapCat', click: restartNapCat },
        { label: '退出', click: () => app.quit() },
      ])
    )
    tray.on('double-click', showMain)
  } catch (e) {
    console.error('tray failed:', e)
  }
}

/* ---------------- app lifecycle ---------------- */

/** 首次运行时创建桌面 / 开始菜单快捷方式（用 Electron 内置 API，不依赖 COM） */
function ensureShortcuts() {
  if (!app.isPackaged) return
  const s = loadSettings()
  if (s.shortcutsCreated) return
  const target = process.execPath
  const options = {
    target,
    cwd: path.dirname(target),
    icon: ICON_ICO,
    iconIndex: 0,
    description: 'NapCat Desktop',
  }
  let created = 0
  const dirs = [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')]
  for (const dir of dirs) {
    try {
      const lnk = path.join(dir, 'NapCat.lnk')
      fs.mkdirSync(dir, { recursive: true })
      if (shell.writeShortcutLink(lnk, 'create', options)) created += 1
    } catch (e) {
      console.error('shortcut failed:', dir, e)
    }
  }
  if (created > 0) saveSettings({ shortcutsCreated: true })
}

ipcMain.on('splash-ready', () => setSplashStatus('正在检查 NapCat 状态…'))

app.whenReady().then(async () => {
  logLine('app ready, packaged=', app.isPackaged)
  if (process.argv.includes('--check')) {
    const base = shellPath()
    let cfg = null
    let up = false
    try {
      cfg = readWebuiConfig(base)
      up = await probeSync(cfg.port)
    } catch (e) {
      console.log(JSON.stringify({ shellPath: base, error: e.message }))
      app.exit(1)
      return
    }
    console.log(JSON.stringify({ shellPath: base, port: cfg.port, hasToken: !!cfg.token, webuiUp: up }))
    app.exit(0)
    return
  }

  app.setAppUserModelId('com.dgcrxs.napcat.desktop')
  ensureShortcuts()
  buildMenu()
  createTray()
  boot()

  app.on('activate', showMain)
})

function probeSync(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

app.on('window-all-closed', () => {
  logLine('window-all-closed -> quit')
  app.quit()
})

app.on('before-quit', () => {
  quitting = true
})

process.on('uncaughtException', (e) => {
  logLine('uncaught:', e && e.stack ? e.stack : String(e))
  console.error('uncaught:', e)
})
