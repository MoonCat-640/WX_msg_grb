/**
 * Electron 主进程入口
 * ------------------------------------------------------------------
 * 启动顺序：
 *   ① 单实例锁（避免同时开两个实例争抢数据库与 wechat_exp 子进程）
 *   ② 初始化保险库与加密数据库
 *   ③ 注册 IPC 通道
 *   ④ 创建主窗口
 *   ⑤ 若已解锁且开启了实时同步，自动启动同步循环
 *
 * 退出顺序（同样重要）：
 *   强制落盘 → 停止同步 → 关闭 wechat_exp 子进程 → 关闭数据库
 */
import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { join } from 'node:path'
import { scoped } from './core/logger'
import { getAppPaths } from './core/paths'
import { getSettings } from './core/settings'
import { initVaultAndStore, isReady } from './core/bootstrap'
import { closeStore, persistNow } from './core/store'
import { disposeIpc, registerIpcHandlers } from './core/ipc-router'
import { closeAllExternalWindows } from './core/external-window'
import { applyTraySettings, isTrayActive, registerTrayHandlers } from './core/tray'
import { startLoop } from './services/sync-service'
import { startLoginWatch, stopLoginWatch } from './services/login-watch'

const log = scoped('main')

/** 主窗口引用（全局保留一个，避免被 GC） */
let mainWindow: BrowserWindow | null = null

/**
 * 是否正在**真正退出**。
 * 用于区分「点关闭按钮 → 最小化到托盘」与「从托盘菜单退出 → 真的关掉」，
 * 否则 before-quit 之后窗口的 close 事件又会被托盘逻辑拦下来，导致退不掉。
 */
let quitting = false

/** 开发模式判定：electron-vite 在 dev 时注入该变量 */
const RENDERER_DEV_URL = process.env['ELECTRON_RENDERER_URL']
const isDev = Boolean(RENDERER_DEV_URL)

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    // 深色底：窗口出现瞬间不会闪白，符合暗色调主题
    backgroundColor: '#17171a',
    autoHideMenuBar: true,
    title: '微信消息任务汇总器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：渲染进程不接触 Node，也不与主进程共享上下文
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 里用了 ipcRenderer，需要非沙箱
      spellcheck: false
    }
  })

  // 首帧渲染完成后再显示，避免白屏闪烁
  win.once('ready-to-show', () => {
    win.show()
    log.info('主窗口已显示')
  })

  // 站内链接不允许在应用内打开，一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })

  if (isDev && RENDERER_DEV_URL) {
    void win.loadURL(RENDERER_DEV_URL)
    win.webContents.openDevTools({ mode: 'detach' })
    log.info('开发模式：加载渲染进程开发服务器', { url: RENDERER_DEV_URL })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
    log.info('生产模式：加载打包后的渲染进程')
  }

  // 关闭行为（第二次更新需求 §3）：
  // 开启「关闭到托盘」时，点关闭按钮只隐藏窗口，软件继续在后台跑同步与登录监听。
  win.on('close', (event) => {
    const settings = getSettings()
    if (!quitting && settings.tray.enabled && settings.tray.closeToTray && isTrayActive()) {
      event.preventDefault()
      win.hide()
      log.info('窗口已收进系统托盘，软件继续在后台运行')
    }
  })

  win.on('closed', () => {
    mainWindow = null
  })

  return win
}

/** 全局只允许一个实例：多开会抢 wechat_exp 子进程与数据库文件 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 已有实例在跑：把那个窗口叫到前台，然后安静退出
  app.quit()
} else {
  app.on('second-instance', () => {
    // 用户又双击了一次图标：把窗口显示出来（可能正收在托盘里）
    showMainWindow()
  })

  app.whenReady().then(bootstrap).catch((e) => {
    log.error('应用启动失败', { error: e instanceof Error ? e.stack ?? e.message : String(e) })
    app.quit()
  })
}

/* ------------------------------------------------------------------ */
/* 启动流程                                                            */
/* ------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  log.info('=== 微信消息任务汇总器 启动 ===', {
    版本: app.getVersion(),
    Electron: process.versions.electron,
    Node: process.versions.node,
    数据目录: getAppPaths().dataDir,
    日志目录: getAppPaths().logDir,
    打包: app.isPackaged
  })

  // 关闭默认菜单（暗色调应用不需要系统菜单栏）
  Menu.setApplicationMenu(null)

  // 收紧权限：拒绝应用内的摄像头/麦克风/定位等请求（本应用不需要）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const denied = ['media', 'geolocation', 'notifications', 'midi', 'midiSysex']
    callback(!denied.includes(permission))
  })

  // ① 保险库 + 数据库
  const { unlocked } = await initVaultAndStore()

  // ② IPC
  registerIpcHandlers()

  // ③ 窗口
  mainWindow = createWindow()

  // ③.5 系统托盘（第二次更新需求 §3）
  //     处理器在这里注册（只有 main 知道怎么显示窗口、怎么退出），
  //     tray.ts 只负责"按设置创建/销毁"，避免模块间循环依赖。
  registerTrayHandlers({
    onShow: showMainWindow,
    onQuit: () => {
      quitting = true
      app.quit()
    }
  })
  applyTraySettings(getSettings())

  // ④ 自动开始同步
  if (unlocked && isReady()) {
    const settings = getSettings()
    if (settings.sync.enabled) {
      log.info('按配置自动启动实时同步', { 间隔ms: settings.sync.intervalMs })
      startLoop().catch((e) => {
        log.error('自动启动同步失败（不影响界面使用）', {
          error: e instanceof Error ? e.message : String(e)
        })
      })
    }
  } else {
    log.warn('保险库未解锁，跳过自动同步；界面解锁后会自动开始')
  }

  // ⑤ 平台登录状态监听（第二次更新需求 §3）
  //    只在用户于设置里显式打开「后台持续捕获」时启动；
  //    开启后由设置变更即时启停（见 ipc-router 的 app:settings:patch）。
  if (getSettings().tray.backgroundCapture) {
    startLoginWatch()
  } else {
    log.info('「后台持续捕获」未开启，跳过平台登录状态监听')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
}

/** 显示（必要时重建）主窗口——托盘的单击与「显示主窗口」菜单都走这里 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/* ------------------------------------------------------------------ */
/* 退出清理                                                            */
/* ------------------------------------------------------------------ */

app.on('window-all-closed', () => {
  // Windows 上关掉窗口即退出应用（符合用户预期）
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let cleanupDone = false

app.on('before-quit', (event) => {
  if (cleanupDone) return
  // 标记为真正退出：否则窗口的 close 事件会被「最小化到托盘」逻辑拦下，退不掉
  quitting = true
  // 清理是异步的，先拦下退出，做完再真正退出
  event.preventDefault()
  void (async () => {
    log.info('开始退出清理…')
    try {
      stopLoginWatch()
      await persistNow()
      await disposeIpc()
      closeAllExternalWindows()
      await closeStore()
    } catch (e) {
      log.error('退出清理出错（仍会继续退出）', {
        error: e instanceof Error ? e.message : String(e)
      })
    } finally {
      cleanupDone = true
      log.info('=== 应用退出 ===')
      app.quit()
    }
  })()
})

// 兜底：未捕获异常必须落日志，否则用户只会看到窗口消失
process.on('uncaughtException', (err) => {
  log.error('未捕获异常', { error: `${err.name}: ${err.message}`, stack: err.stack })
})
process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', { reason: reason instanceof Error ? reason.message : String(reason) })
})
