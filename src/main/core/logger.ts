/**
 * 日志系统
 * ------------------------------------------------------------------
 * 设计目标（对应需求「日志系统：记录关键操作和错误，便于调试」）：
 *   1. 同时写「文件」与「内存环形缓冲」——文件用于事后排查，环形缓冲供界面实时查看
 *   2. 按天切分文件：logs/app-YYYY-MM-DD.log
 *   3. 通过 IPC 实时推送给界面，调试时可以边操作边看日志
 *   4. 所有外部调用（wechat_exp / LLM API）都必须落日志，带 scope 便于过滤
 */
import { BrowserWindow } from 'electron'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEntry, LogLevel } from '@shared/types'
import { getAppPaths } from './paths'

/** 内存中保留的日志条数（界面日志面板上限） */
const RING_SIZE = 2000
/** 日志文件保留天数 */
const KEEP_DAYS = 14

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const ring: LogEntry[] = []
let minLevel: LogLevel = 'info'
let currentDay = ''
let streamReady = false

/** 读取当天的日志文件路径（按需切换） */
function logFileForToday(): string {
  const paths = getAppPaths()
  const now = new Date()
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  if (day !== currentDay) {
    currentDay = day
    streamReady = false
  }
  return join(paths.logDir, `app-${day}.log`)
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 本地时间戳字符串（UTC+8 由系统时区决定，与需求一致） */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  )
}

/** 清理过期日志文件 */
function pruneOldLogs(): void {
  try {
    const dir = getAppPaths().logDir
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
    for (const name of readdirSync(dir)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      } catch {
        /* 忽略单个文件清理失败 */
      }
    }
  } catch {
    /* 日志清理失败不应影响主流程 */
  }
}

/** 把 detail 序列化成单行可读文本 */
function stringifyDetail(detail: unknown): string {
  if (detail === undefined) return ''
  if (detail instanceof Error) return ` | ${detail.name}: ${detail.message}`
  try {
    const s = typeof detail === 'string' ? detail : JSON.stringify(detail)
    return ` | ${s}`
  } catch {
    return ' | [无法序列化的 detail]'
  }
}

/** 广播日志到所有渲染进程窗口 */
function broadcast(entry: LogEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('log', entry)
    }
  }
}

/** 写入一条日志 */
export function log(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const entry: LogEntry = { ts: Date.now(), level, scope, message, detail }

  // 1) 环形缓冲（无论级别都收，界面自行过滤）
  ring.push(entry)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)

  // 2) 低于阈值的不写文件、不推送，但控制台 debug 仍打印（开发便利）
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return

  const line = `[${formatTime(entry.ts)}] [${level.toUpperCase().padEnd(5)}] [${scope}] ${message}${stringifyDetail(detail)}\n`

  // 3) 控制台
  if (level === 'error') console.error(line.trimEnd())
  else if (level === 'warn') console.warn(line.trimEnd())
  else console.log(line.trimEnd())

  // 4) 文件
  try {
    const file = logFileForToday()
    if (!streamReady) {
      streamReady = true
      if (!existsSync(file)) {
        appendFileSync(file, `# 微信消息任务汇总器 日志文件 — ${file}\n`, 'utf8')
      }
      pruneOldLogs()
    }
    appendFileSync(file, line, 'utf8')
  } catch {
    /* 磁盘写失败不能拖垮应用 */
  }

  // 5) 推送界面
  broadcast(entry)
}

/** 设置最低输出级别 */
export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

/** 读取内存中的日志（界面日志面板） */
export function readLogs(limit = 500, level?: string): LogEntry[] {
  const filtered =
    level && level !== 'all' ? ring.filter((e) => e.level === level) : ring.slice()
  return filtered.slice(-limit)
}

/** 清空内存日志（不动文件） */
export function clearLogs(): void {
  ring.length = 0
}

/** 读取今天日志文件的内容（用于「打开日志文件」预览） */
export function readLogFileTail(maxBytes = 200_000): string {
  try {
    const file = logFileForToday()
    if (!existsSync(file)) return ''
    const buf = readFileSync(file)
    return buf.length <= maxBytes ? buf.toString('utf8') : buf.subarray(buf.length - maxBytes).toString('utf8')
  } catch (e) {
    return `读取日志文件失败: ${String(e)}`
  }
}

/* ------------------------------------------------------------------
 * 便捷封装：logger.for('scope').info('...')
 * ------------------------------------------------------------------ */

export interface ScopedLogger {
  debug(message: string, detail?: unknown): void
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
  /** 包裹一个异步调用：记录耗时与失败原因，便于排查外部调用 */
  span<T>(message: string, fn: () => Promise<T> | T): Promise<T>
}

export function scoped(scope: string): ScopedLogger {
  return {
    debug: (m, d) => log('debug', scope, m, d),
    info: (m, d) => log('info', scope, m, d),
    warn: (m, d) => log('warn', scope, m, d),
    error: (m, d) => log('error', scope, m, d),
    async span<T>(message: string, fn: () => Promise<T> | T): Promise<T> {
      const start = Date.now()
      try {
        const result = await fn()
        log('debug', scope, `${message} 完成`, { 耗时ms: Date.now() - start })
        return result
      } catch (e) {
        log('error', scope, `${message} 失败`, {
          耗时ms: Date.now() - start,
          错误: e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        })
        throw e
      }
    }
  }
}
