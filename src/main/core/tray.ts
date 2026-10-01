/**
 * 系统托盘（第二次更新需求 §3）
 * ==================================================================
 * 需求原文：
 *   「无需每次开启都重新运行 wechat_exp 和 QQFlow，软件可以在系统后台运行，
 *     持续捕获任务（该功能可以在设置中调整开始和关闭）。」
 *
 * 实现要点：
 *   - 托盘图标用**内嵌的 base64 PNG**，不依赖外部图标文件
 *     （项目里没有 icon.ico，托盘再要求一个资源文件会让打包多一处易错点）。
 *   - 菜单保持克制：只放「显示主窗口 / 退出」，其余操作都在主界面里，
 *     避免托盘菜单与主界面两套状态互相打架。
 *   - 关闭窗口的行为由设置 tray.closeToTray 决定（见 main/index.ts 的 close 处理）。
 */
import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import type { AppSettings } from '@shared/types'
import { scoped } from './logger'

const log = scoped('tray')

/**
 * 32×32 托盘图标（PNG，透明底）：
 * 一个圆角气泡 + 三个白点，取主题蓝 #5B8DEF。
 * 用 base64 内嵌，避免打包时漏带资源文件。
 */
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAFtSURBVFhH7ZevT8NAFMcnkUj+BOQkkj8BuztRJEHNkMwxR9LdBQmKWgwagcANicWhCOHH7mUIFhJIybuxrP32Wrqut2XJvsnHvLx332+b3e7aaKy1VoFa6m1bKNqXmrpV4XkRUhPXLpQdUoakprguhKaRVKaDXhkJRdc4XCdC0V1w/LiBvlaiNzjAAR8ITSfobWVfk2PAB0H4spU2D6mJTT5pKdpLBZCa2tjkmS4G4G2DTT5ZoQAXN5/x0+A7vuqP5qoD5QO8Dn/iiQ7Ph5XrlQP0H77sYvxU89SB8gGYo+gjU6tSTzBbAA9AAGU6jiafQIAe7TqavMEnbioAn1DY5BO+a6QCsKSmM2z0AR/56G3Fb0FoesaBOuGLTuYkTCo4pU2pTYSDuShHLQd+8kLzpPh4Hl9QzCUuNMXc/23f/2hL/b6DHqWUf08wEfZ6kXt3LMh8ovQPc8HmLKHN7dLMWeP/hyWZs2b+slkl/QJHdX6i4YwrigAAAABJRU5ErkJggg=='

let tray: Tray | null = null

/** 创建托盘图标（幂等：已存在则直接返回） */
export function createTray(handlers: { onShow: () => void; onQuit: () => void }): Tray | null {
  if (tray) return tray

  const icon: NativeImage = nativeImage.createFromDataURL(
    `data:image/png;base64,${TRAY_ICON_PNG_BASE64}`
  )
  if (icon.isEmpty()) {
    // 理论上不会发生；真发生了也不该让启动失败
    log.warn('托盘图标加载失败（base64 可能损坏），跳过托盘创建')
    return null
  }

  try {
    tray = new Tray(icon)
  } catch (e) {
    log.warn('托盘创建失败（可能是系统限制），应用仍可正常使用', {
      error: e instanceof Error ? e.message : String(e)
    })
    return null
  }

  tray.setToolTip('微信消息任务汇总器')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => handlers.onShow() },
      { type: 'separator' },
      { label: '退出', click: () => handlers.onQuit() }
    ])
  )
  // 左键单击/双击托盘图标都唤出主窗口（Windows 上习惯单击）
  tray.on('click', () => handlers.onShow())
  tray.on('double-click', () => handlers.onShow())

  log.info('系统托盘已创建')
  return tray
}

/** 销毁托盘（设置里关掉托盘时调用） */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
    log.info('系统托盘已销毁')
  }
}

/** 托盘是否存在（供设置界面/关闭逻辑判断） */
export function isTrayActive(): boolean {
  return tray !== null
}

/* ------------------------------------------------------------------ */
/* 设置驱动的创建/销毁                                                 */
/* ------------------------------------------------------------------ */

/**
 * 托盘菜单动作的处理器。
 * 由 main/index.ts 在启动时注册（那里才知道怎么显示窗口、怎么退出），
 * 这样 tray.ts 不需要反向 import 主入口，避免循环依赖。
 */
let handlers: { onShow: () => void; onQuit: () => void } | null = null

/** 注册托盘菜单动作（启动时调用一次） */
export function registerTrayHandlers(h: { onShow: () => void; onQuit: () => void }): void {
  handlers = h
}

/**
 * 按设置应用托盘状态，**可安全重复调用**（设置变更后重新应用）：
 *   - tray.enabled=false → 销毁托盘
 *   - tray.enabled=true  → 创建（已存在则跳过）
 */
export function applyTraySettings(settings: AppSettings): void {
  if (!settings.tray.enabled) {
    destroyTray()
    return
  }
  if (tray) return
  if (!handlers) {
    log.warn('托盘处理器尚未注册，本次跳过托盘创建')
    return
  }
  createTray(handlers)
}

/** 更新托盘提示（例如显示同步状态） */
export function setTrayTooltip(text: string): void {
  if (tray) tray.setToolTip(text)
}
