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
// 销毁 splash 与创建主窗口之间会出现「0 窗口」瞬间，window-all-closed 会误判成
// 「所有窗口都关了」而 app.quit()。用它把这段窗口期屏蔽掉，
// 复位在 createSplash() / createMainWindow() 的结尾。
let creatingWindow = false

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

function probe(port, timeout = 600) {
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

/**
 * 解析 QQ.exe 路径。
 * 优先用 settings 里缓存的 qqPath（同步、零开销，启动时省掉一次 reg 查询）；
 * 缓存失效才去注册表查，查到了写回 settings 供下次直接用。
 */
function resolveQQPath() {
  const cached = loadSettings().qqPath
  if (cached && fs.existsSync(cached)) return Promise.resolve(cached)

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
        if (!fs.existsSync(qq)) return resolve(null)
        saveSettings({ qqPath: qq })
        resolve(qq)
      }
    )
  })
}

/** 检测 QQ.exe 是否正在运行（一次 tasklist 查询，不需要提权） */
function isQQRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(false)
      resolve(/QQ\.exe/i.test(stdout))
    })
  })
}

/**
 * 把提权拉起的脚本写成 cmd 壳，放在 userData 下（该目录无空格）。
 *
 * 关键点：UAC 提权（ShellExecute / -Verb RunAs）创建的新进程**不会**继承父
 * PowerShell 会话里刚设的 $env:NAPCAT_* 变量，于是 NapCatWinBootMain.exe 拿不到
 * patch 包 / load 路径，注入后 QQ 校验失败会弹「QQ 文件已损坏」。
 * 所以照 NapCat 自带 launcher.bat 的做法：先提权整个 cmd 壳，再在提权后的会话
 * 内部设置环境变量并直接调用 NapCatWinBootMain.exe。
 *
 * @param {string} base NapCat 目录（含 NapCatWinBootMain.exe）
 * @param {string} token WebUI 密钥，为空则整行不写
 * @param {string} qqPath QQ.exe 绝对路径
 * @returns {string} 生成的 cmd 文件绝对路径
 */
function writeLaunchCmd(base, token, qqPath) {
  const launchLog = path.join(app.getPath('userData'), 'launch.log')
  const cmdPath = path.join(app.getPath('userData'), 'start-napcat.cmd')
  const lines = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `cd /d "${base}"`,
    // 提权检测用 fltmc 而不是 net session：后者依赖 LanmanServer 服务，
    // 该服务被停用时 net session 会返回 2114，被误判成「未提权」直接 exit /b 5。
    'fltmc >nul 2>&1',
    'if errorlevel 1 (',
    `  echo [%date% %time%] ERROR: not elevated>>"${launchLog}"`,
    '  exit /b 5',
    ')',
    'set "NAPCAT_PATCH_PACKAGE=%CD%\\qqnt.json"',
    'set "NAPCAT_LOAD_PATH=%CD%\\loadNapCat.js"',
    'set "NAPCAT_INJECT_PATH=%CD%\\NapCatWinBootHook.dll"',
    'set "NAPCAT_LAUNCHER_PATH=%CD%\\NapCatWinBootMain.exe"',
    'set "NAPCAT_MAIN_PATH=%CD%\\napcat.mjs"',
  ]
  if (token) lines.push(`set "NAPCAT_WEBUI_SECRET_KEY=${token}"`)
  lines.push(
    `echo [%date% %time%] launching NapCat from %CD%>>"${launchLog}"`,
    `"%CD%\\NapCatWinBootMain.exe" "${qqPath}" "%CD%\\NapCatWinBootHook.dll" >>"${launchLog}" 2>&1`,
    `echo [%date% %time%] launcher exited %ERRORLEVEL%>>"${launchLog}"`
  )
  try {
    fs.mkdirSync(path.dirname(cmdPath), { recursive: true })
    fs.writeFileSync(cmdPath, `${lines.join('\r\n')}\r\n`, 'utf-8')
  } catch (e) {
    logLine('writeLaunchCmd failed:', String(e))
  }
  logLine('writeLaunchCmd ->', cmdPath, 'base=', base, 'tokenLen=', String(token || '').length)
  return cmdPath
}

/**
 * 以管理员身份启动 NapCat（注入 QQ）。返回 { ok, error }
 *
 * 提权对象是 cmd 壳而不是 NapCatWinBootMain.exe：这样环境变量在提权后的会话里
 * 才能生效。用 -WindowStyle Minimized 而非 Hidden —— 要给 NapCat 留一个真实的
 * 控制台句柄，Hidden 会让它的 console 输出失效。
 */
function startNapCat(base, qqPath, token) {
  return new Promise((resolve) => {
    const exe = path.join(base, 'NapCatWinBootMain.exe')
    if (!fs.existsSync(exe)) {
      return resolve({ ok: false, error: `未找到 NapCatWinBootMain.exe：${exe}` })
    }
    if (!qqPath) {
      return resolve({ ok: false, error: '未在注册表中找到 QQ 安装路径，请确认 QQ 已正确安装' })
    }

    const cmdPath = writeLaunchCmd(base, token, qqPath)
    const arg = cmdPath.includes(' ') ? `"${cmdPath}"` : cmdPath
    const ps = `Start-Process -FilePath $env:ComSpec -ArgumentList '/c','${arg}' -Verb RunAs -WindowStyle Minimized`
    // 日志里 token 只记长度，避免密钥落盘
    logLine('startNapCat: ps=', ps, 'tokenLen=', String(token || '').length)

    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          logLine('startNapCat failed: stderr=', stderr || '', 'msg=', err.message)
          const cancelled = /cancell?ed|1312|操作已被取消/i.test(`${stderr} ${err.message}`)
          return resolve({
            ok: false,
            error: cancelled
              ? '已取消管理员授权（NapCat 需要管理员权限注入 QQ）'
              : `启动失败：${stderr || err.message}`,
          })
        }
        logLine('startNapCat: launcher shell started')
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
  // 重入保护：二次 boot 时直接复用现有 splash，避免覆盖引用泄漏旧 BrowserWindow
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow
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
  creatingWindow = false // 已经把窗口补回来了，恢复 window-all-closed 的正常语义
  return splashWindow
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

  creatingWindow = false // 主窗口已存在，恢复 window-all-closed 的正常语义
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
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

async function boot() {
  creatingWindow = false // 每次进入 boot 先复位窗口期旗标（重试路径会由 createSplash/createMainWindow 重新复位）
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
    // destroy() 会同步触发 window-all-closed，先立旗屏蔽掉这段 0 窗口期
    creatingWindow = true
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
    splashWindow = null
    logLine('boot: webui already up')
    createMainWindow(webuiUrl(cfg, token))
    return
  }

  createSplash()
  setSplashStatus('正在检查 QQ 状态…', '需要管理员权限注入 QQ，请在弹窗中确认')

  // resolveQQPath / isQQRunning 互不依赖，并行执行省掉一次串行等待
  const [qqPath, qqRunning] = await Promise.all([resolveQQPath(), isQQRunning()])

  // 先确认拿到 QQ 路径：拿不到就直接退出，绝不能「先杀掉用户正在用的 QQ 再报错」
  if (!qqPath) {
    logLine('boot: qqPath not found, abort before killing QQ')
    setSplashStatus('未找到 QQ', '未在注册表中找到 QQ 安装路径')
    dialog.showErrorBox(
      '未找到 QQ 安装路径',
      '未在注册表中找到 QQ 安装路径，无法启动 NapCat。\n\n请确认 QQ 已正确安装，或通过菜单「设置 NapCat 目录…」确认目录。'
    )
    app.quit()
    return
  }

  if (qqRunning) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'QQ 正在运行',
      message: 'QQ 当前已在运行，但还没有加载 NapCat。',
      detail: 'NapCat 只能在 QQ 启动时注入，需要先关闭 QQ 再重新拉起（关闭后需要重新扫码/快速登录）。',
      buttons: ['关闭 QQ 并继续', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice !== 0) {
      app.quit()
      return
    }
    setSplashStatus('正在关闭 QQ…', '关闭后会重新拉起 QQ 并注入 NapCat')
    logLine('boot: killing running QQ before inject')
    await new Promise((r) => {
      execFile('taskkill', ['/IM', 'QQ.exe', '/F'], { windowsHide: true }, () => r())
    })
    await new Promise((r) => setTimeout(r, 1500))
  }

  // 文案先刷出去，不要等 await 之后再更新（否则 splash 会长时间停在上一句）
  setSplashStatus('正在启动 NapCat…', '需要管理员权限注入 QQ，请在弹窗中确认')
  let result = await startNapCat(base, qqPath, token)
  while (!result.ok) {
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
    if (choice === 1) {
      // 只打开目录，然后回到对话框：用户还能接着点「重试」（以前这里会直接 app.quit）
      shell.openPath(base)
      continue
    }
    if (choice !== 0) {
      app.quit()
      return
    }
    creatingWindow = true // 销毁 splash 会同步触发 window-all-closed，先屏蔽这段 0 窗口期
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
    splashWindow = null
    return boot()
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

  // 关闭 QQ → 等它退干净 → 复用统一的 startNapCat（不再复制一份提权脚本）
  logLine('restartNapCat: killing QQ')
  execFile('taskkill', ['/IM', 'QQ.exe', '/F'], { windowsHide: true }, async () => {
    await new Promise((r) => setTimeout(r, 1500))
    const qqPath = await resolveQQPath()
    const result = await startNapCat(base, qqPath, token)
    if (!result.ok) {
      dialog.showErrorBox('重启失败', result.error)
      return
    }
    if (!mainWindow || mainWindow.isDestroyed()) return
    const cfg = readWebuiConfig(base)
    // startNapCat 的 resolve 只代表「提权 cmd 壳已拉起」，NapCat 还要 20~60 秒才监听
    // 端口。立刻 loadURL 会得到 ERR_CONNECTION_REFUSED（checkLoginState 里
    // 「重启 NapCat（推荐）」按钮走的就是这条路径），所以这里等 WebUI 真正就绪。
    logLine('restartNapCat: waiting for webui on port', cfg.port)
    const ready = await waitForWebui(cfg.port)
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (ready) {
      mainWindow.loadURL(webuiUrl(cfg, token))
    } else {
      // 超时兜底：让页面自己重试，别把用户丢在错误页上干等 F5
      logLine('restartNapCat: waitForWebui timeout, reload as fallback')
      mainWindow.reload()
    }
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
  // 拆 splash → 建主窗口之间存在「0 窗口」瞬间，此时不能退出（见 creatingWindow）
  if (creatingWindow) {
    logLine('window-all-closed during window swap, ignored')
    return
  }
  logLine('window-all-closed -> quit')
  app.quit()
})

process.on('uncaughtException', (e) => {
  logLine('uncaught:', e && e.stack ? e.stack : String(e))
  console.error('uncaught:', e)
})

process.on('unhandledRejection', (e) => {
  logLine('unhandledRejection:', e && e.stack ? e.stack : String(e))
  console.error('unhandledRejection:', e)
})
