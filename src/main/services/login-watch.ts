/**
 * 平台登录状态监听（第二次更新需求 §3）
 * ==================================================================
 * 需求原文：
 *   「无需每次开启都重新运行 wechat_exp 和 QQFlow，软件可以在系统后台运行，
 *     持续捕获任务（该功能可以在设置中调整开始和关闭）。
 *     注意实现：微信和 QQ 的密钥提取需要平台处于登录状态，且存在"密钥窗口期"。
 *     软件应监听微信/QQ的登录状态，在检测到登录后触发密钥提取，
 *     而不是盲目定时轮询。」
 *
 * 实现要点：
 *   - 用 `tasklist` 探测平台客户端进程是否在运行（近似"已登录"）。
 *     选 tasklist 而不是常驻 Windows API：不引入原生依赖，且解析判据是
 *     「输出里有没有带引号的进程名」，与系统语言无关（中文/英文输出都能判）。
 *   - **只在状态跳变时触发回调**（未运行 → 运行），而不是每轮都触发——
 *     这就是需求里说的"不盲目轮询"。首轮只建立基线，不触发。
 *   - 回调由上层（main）决定做什么：QQ 走"打开 QQFlow / 导入密钥"，
 *     微信走"开始同步"。本模块只负责"检测 + 通知"，不掺杂业务。
 */
import { execFileSync } from 'node:child_process'
import type { PlatformId, PlatformLoginState } from '@shared/types'
import { scoped } from '@main/core/logger'
import { getSettings } from '@main/core/settings'
import { listAccountsByPlatform } from '@main/data/account-repo'
import { listQqKeyAccounts, readQqflowKeys } from '@main/qq'

const log = scoped('login-watch')

/** 监听轮询间隔。15 秒足够及时，且 tasklist 很轻量。 */
const WATCH_INTERVAL_MS = 15_000

/**
 * 判断"客户端在运行"用的进程名。
 * QQ NT 与微信 4.x 都是 Electron 架构，主进程名如下（微信另含小程序容器进程）。
 */
const PLATFORM_PROCESSES: Record<PlatformId, string[]> = {
  qq: ['QQ.exe'],
  wechat: ['WeChat.exe', 'Weixin.exe', 'WeChatAppEx.exe']
}

/** 探测一组进程名里是否有任意一个在运行（返回命中的那个名字） */
function detectProcessRunning(imageNames: string[]): { running: boolean; matched?: string } {
  for (const name of imageNames) {
    try {
      // /NH 不要表头；/FO CSV 便于稳定判断；-FI 过滤进程名
      const out = execFileSync(
        'tasklist',
        ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${name}`],
        { timeout: 4000, windowsHide: true, encoding: 'utf8' }
      )
      // 命中时输出行形如： "QQ.exe","12345","Console","1","123,456 K"
      // 未命中时输出一条本地化的提示（不含带引号的进程名），故按带引号名判断最稳。
      if (out && out.toLowerCase().includes(`"${name.toLowerCase()}"`)) {
        return { running: true, matched: name }
      }
    } catch (e) {
      // tasklist 不可用（极少见）不应让整个监听崩掉
      log.warn('tasklist 探测进程失败', { name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { running: false }
}

/** 安全读取「已有 QQFlow 密钥」的账号数（文件/保险库未就绪时按 0 处理） */
function safeQqflowKeyCount(): number {
  try {
    return Object.keys(readQqflowKeys()).length
  } catch {
    return 0
  }
}

/** 安全读取「本应用已保存的 QQ 密钥」账号数 */
function safeQqSavedKeyCount(): number {
  try {
    return listQqKeyAccounts().length
  } catch {
    return 0
  }
}

/** 采集一次两个平台的登录状态快照 */
export function getPlatformLoginStates(): PlatformLoginState[] {
  const now = Date.now()
  const out: PlatformLoginState[] = []

  // ---- QQ ----
  const qqProc = detectProcessRunning(PLATFORM_PROCESSES.qq)
  const qqAccounts = listAccountsByPlatform('qq').length
  const qqHasKey = safeQqSavedKeyCount() > 0 || safeQqflowKeyCount() > 0
  out.push({
    platform: 'qq',
    running: qqProc.running,
    ready: qqAccounts > 0 && qqHasKey,
    processName: qqProc.matched,
    message: qqProc.running
      ? qqHasKey
        ? 'QQ 正在运行，且已具备可用密钥'
        : 'QQ 正在运行，但尚未提取数据库密钥（可打开 QQFlow 提取密钥）'
      : '未检测到 QQ 客户端运行',
    checkedAt: now
  })

  // ---- 微信 ----
  const wxProc = detectProcessRunning(PLATFORM_PROCESSES.wechat)
  const wxAccounts = listAccountsByPlatform('wechat').length
  out.push({
    platform: 'wechat',
    running: wxProc.running,
    ready: wxAccounts > 0,
    processName: wxProc.matched,
    message: wxProc.running
      ? wxAccounts > 0
        ? '微信正在运行，可读取聊天记录'
        : '微信正在运行，但尚未识别账号（可在"联系人与群聊"里识别本机账号）'
      : '未检测到微信客户端运行',
    checkedAt: now
  })

  return out
}

/* ------------------------------------------------------------------ */
/* 监听循环                                                            */
/* ------------------------------------------------------------------ */

let timer: NodeJS.Timeout | null = null
/** 上一轮各平台的运行状态，用于判断跳变 */
let lastRunning: Record<PlatformId, boolean> = { qq: false, wechat: false }
let baselineReady = false

/**
 * 检测到某平台**刚登录**（未运行 → 运行）时执行的动作。
 *
 * 策略（第二次更新需求 §3「在检测到登录后触发密钥提取」）：
 *   - QQ：若 QQFlow 已提取过密钥 → 直接导入本软件保险库（无感）；
 *         否则只记日志提示——**不自动弹 QQFlow 窗口**，因为后台突然弹窗很打扰，
 *         用户可以随时在「账户管理」里点「打开 QQFlow」手动提取。
 *   - 微信：无需动作，同步循环已按间隔读取（走 wechat_exp 的 HTTP 接口）。
 */
async function handlePlatformLogin(state: PlatformLoginState): Promise<void> {
  log.info('后台捕获：检测到平台登录', { platform: state.platform, message: state.message })
  if (state.platform !== 'qq') return

  try {
    const q = await import('@main/qq')
    const keys = q.readQqflowKeys()
    const available = Object.keys(keys)
    if (available.length === 0) {
      log.info('QQ 已登录，但 QQFlow 尚未提取过密钥；可在「账户管理」里点「打开 QQFlow」提取')
      return
    }
    const imported = q.importKeysFromQqflow()
    log.info('QQ 已登录，已从 QQFlow 自动导入密钥', { 导入条数: imported, 可用账号: available.length })
  } catch (e) {
    log.warn('自动导入 QQFlow 密钥失败（不影响其它功能）', {
      error: e instanceof Error ? e.message : String(e)
    })
  }
}

/**
 * 启动监听循环。幂等：重复调用不会起多个定时器。
 * 由设置里的「后台持续捕获」开关控制，见 ipc-router 的 app:settings:patch。
 */
export function startLoginWatch(): void {
  if (timer) return
  const settings = getSettings()
  log.info('启动平台登录状态监听', {
    间隔ms: WATCH_INTERVAL_MS,
    后台捕获: settings.tray.backgroundCapture
  })

  // 首轮只建立基线，不触发回调（避免每次开软件都误报"刚登录"）
  try {
    for (const s of getPlatformLoginStates()) lastRunning[s.platform] = s.running
    baselineReady = true
  } catch (e) {
    log.warn('建立登录状态基线失败', { error: e instanceof Error ? e.message : String(e) })
  }

  timer = setInterval(() => {
    let states: PlatformLoginState[]
    try {
      states = getPlatformLoginStates()
    } catch (e) {
      log.warn('采集平台登录状态失败', { error: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!baselineReady) {
      for (const s of states) lastRunning[s.platform] = s.running
      baselineReady = true
      return
    }
    for (const s of states) {
      const was = lastRunning[s.platform]
      if (s.running && !was) {
        // 捕获 Promise 拒绝：回调是 async 的，不 await 也要防止未处理拒绝
        void handlePlatformLogin(s).catch((e) => {
          log.warn('登录回调执行出错', {
            platform: s.platform,
            error: e instanceof Error ? e.message : String(e)
          })
        })
      }
      lastRunning[s.platform] = s.running
    }
  }, WATCH_INTERVAL_MS)
}

/** 停止监听循环 */
export function stopLoginWatch(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    log.info('已停止平台登录状态监听')
  }
  lastRunning = { qq: false, wechat: false }
  baselineReady = false
}

/** 监听是否在跑（供设置界面展示） */
export function isLoginWatchRunning(): boolean {
  return timer !== null
}
