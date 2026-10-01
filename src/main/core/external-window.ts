/**
 * 按账号隔离的外部网页窗口
 * ------------------------------------------------------------------
 * 需求原文：「涉及线上链接的，单击链接进入后，该程序直接使用获取该任务的账号进行登录」
 *
 * 技术现实：微信/QQ 的登录态**无法**迁移到第三方网站（如腾讯文档、问卷星）。
 * 能真正做到的是「**按账号隔离浏览器会话**」：
 *   - 每个账号一个独立的 Electron session 分区（persist:acct-<accountId>）
 *   - 用某账号打开过的网站，其 Cookie / 登录态只保存在该分区里
 *   - 下次仍用该账号打开同一网站，就是已登录状态；换账号打开则是另一套 Cookie
 * 这样在「同一台电脑登录多个账号」的场景下，等价于需求想要的效果，
 * 且不需要（也无法）伪造第三方网站的登录。
 */
import { BrowserWindow, shell } from 'electron'
import { scoped } from './logger'
import { errors } from './errors'

const log = scoped('external')

/** 按账号缓存窗口，避免每次点击都开新窗口 */
const windows = new Map<string, BrowserWindow>()

/** 只允许 http / https，防止 file:// 或自定义协议被打开（安全底线） */
function assertSafeUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw errors.invalidArg(`链接格式不正确：${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw errors.invalidArg(`出于安全考虑，只允许打开 http/https 链接（收到 ${parsed.protocol}）`)
  }
  return parsed
}

/**
 * 打开一个链接。
 * @param url 目标网址
 * @param accountId 用哪个账号的会话分区打开；不传则用默认浏览器打开
 */
export async function openExternalWithAccount(url: string, accountId?: string): Promise<void> {
  const parsed = assertSafeUrl(url)

  // 没有账号上下文时，直接交给系统默认浏览器（更符合用户预期）
  if (!accountId) {
    log.info('用系统默认浏览器打开链接', { url: parsed.toString() })
    await shell.openExternal(parsed.toString())
    return
  }

  const key = `${accountId}::${parsed.host}`
  const existing = windows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.loadURL(parsed.toString()).catch((e) => {
      log.warn('复用窗口加载链接失败', { url: parsed.toString(), error: String(e) })
    })
    existing.focus()
    log.info('复用已打开的账号窗口', { accountId, host: parsed.host })
    return
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    title: `用「${accountId}」的账号会话打开 · ${parsed.host}`,
    backgroundColor: '#1b1b1f',
    autoHideMenuBar: true,
    webPreferences: {
      // 关键：按账号隔离 Cookie / 登录态
      partition: `persist:acct-${accountId}`,
      // 外部网页一律禁用 Node 能力，避免把桌面应用暴露给网页
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  // 站内跳转保持在窗口内；站外链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      assertSafeUrl(target)
      void shell.openExternal(target)
    } catch (e) {
      log.warn('拦截了不安全的跳转', { target, error: String(e) })
    }
    return { action: 'deny' }
  })

  win.on('closed', () => {
    windows.delete(key)
  })

  await win.loadURL(parsed.toString())
  log.info('已用账号会话打开链接', { accountId, host: parsed.host })
}

/** 关闭所有由本模块打开的窗口（退出时清理） */
export function closeAllExternalWindows(): void {
  for (const [, win] of windows) {
    if (!win.isDestroyed()) win.close()
  }
  windows.clear()
}
