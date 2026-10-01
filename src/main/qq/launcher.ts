/**
 * QQFlow 启动器（第二次更新需求 §2 / §5）
 * ==================================================================
 * 背景：
 *   需求原本要求"魔改 QQFlow 源码"，但 QQFlow 的 README 未声明 LICENSE，
 *   魔改并分发存在合规风险，因此**已调整为**：不改 QQFlow 源码，把它当成
 *   外部依赖，由本软件"调用"它。
 *
 * 关键事实（已核对 QQFlow 源码 main.rs）：
 *   QQFlow 是**纯 GUI 程序，不解析任何命令行参数**，因此"调用"只能是
 *   **启动它的进程**——用户在它自己的窗口里点「开始提取密钥」，密钥写到
 *   %APPDATA%\qqflow\qqflow_keys.json，之后由本软件 qq:importFromQqflow 导入。
 *
 * 本模块只做两件事：定位 QQFlow.exe、启动它。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { scoped } from '../core/logger'
import { findQqflowCandidates } from '../core/paths'
import { getSettings } from '../core/settings'

const log = scoped('qqflow')

/** QQFlow 官方仓库地址（提示用户去哪里下载时用） */
export const QQFLOW_REPO = 'https://github.com/yfgug/QQFlow'

/**
 * 解析 QQFlow.exe 的实际路径。
 * 优先级：设置里手动指定 → 自动搜索（tools\ / reference\ / 程序目录等）。
 */
export function resolveQqflowPath(): string | null {
  const settings = getSettings()
  if (settings.qqflowPath && existsSync(settings.qqflowPath)) {
    return settings.qqflowPath
  }
  const candidates = findQqflowCandidates()
  if (candidates.length === 0) return null
  // 优先官方名 QQFlow.exe，否则取搜索到的第一个
  return candidates.find((p) => /qqflow\.exe$/i.test(p)) ?? candidates[0]
}

/** 探测 QQFlow 是否已就位 */
export function probeQqflow(): { found: boolean; path?: string } {
  const path = resolveQqflowPath()
  return path ? { found: true, path } : { found: false }
}

/**
 * 启动 QQFlow（后台起进程，不等待退出）。
 * 返回体里带可展示的 message，界面直接弹提示即可。
 */
export function launchQqflow(): { launched: boolean; path?: string; message: string } {
  const path = resolveQqflowPath()
  if (!path) {
    log.warn('未找到 QQFlow.exe，无法启动')
    return {
      launched: false,
      message: `未找到 QQFlow.exe。请前往 ${QQFLOW_REPO} 下载后放到软件目录的 tools\\ 下，或在"设置"里手动指定路径。`
    }
  }
  try {
    // detached + unref：让 QQFlow 独立于本软件运行，本软件退出也不影响它
    const child = spawn(path, [], { detached: true, stdio: 'ignore' })
    child.unref()
    log.info('已启动 QQFlow', { path, pid: child.pid })
    return {
      launched: true,
      path,
      message: '已打开 QQFlow，请在它的窗口里点「开始提取密钥」并登录 QQ；提取成功后回到本软件的"账户管理"点「导入密钥」。'
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    log.error('启动 QQFlow 失败', { path, error: detail })
    return { launched: false, path, message: `启动 QQFlow 失败：${detail}` }
  }
}
