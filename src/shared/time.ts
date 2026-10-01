/**
 * 时间工具（统一按 UTC+8 口径）
 * ------------------------------------------------------------------
 * 需求明确要求「获取电脑现在的时间（UTC+8:00）」。
 * 所有「天」的边界（例如任务截止到某天）都按 UTC+8 计算，
 * 这样即使用户电脑时区设置变了，展示与判定也保持一致。
 *
 * 内部存储一律用 Unix 毫秒时间戳，只有展示和「按天」判定才走本文件的函数。
 */

/** UTC+8 相对 UTC 的偏移（毫秒） */
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0')
}

/** 把时间戳换算成 UTC+8 的「年月日时分秒」字段 */
export function utc8Parts(ts: number): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
} {
  const d = new Date(ts + TZ_OFFSET_MS)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay()
  }
}

/** `2026-09-27 14:03` */
export function formatDateTime(ts: number): string {
  if (!ts) return '—'
  const p = utc8Parts(ts)
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/** `09-27 14:03`（紧凑展示） */
export function formatShortDateTime(ts: number): string {
  if (!ts) return '—'
  const p = utc8Parts(ts)
  return `${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/** `2026-09-27` */
export function formatDate(ts: number): string {
  if (!ts) return '—'
  const p = utc8Parts(ts)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * 转成 `<input type="datetime-local">` 需要的值：`2026-09-27T14:03`。
 * 注意用的是 **UTC+8 墙钟时间**（与全项目展示口径一致），
 * 空/无效时间返回空串（让输入框显示为未填写）。
 * 反向解析直接用 parseUtc8()——它本就按 UTC+8 解释 `YYYY-MM-DDTHH:mm`。
 */
export function toDateTimeLocalValue(ts?: number): string {
  if (!ts) return ''
  const p = utc8Parts(ts)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** `2026-09-27T14:03:07+08:00`（导出/日志用） */
export function formatIso(ts: number): string {
  if (!ts) return '—'
  const p = utc8Parts(ts)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+08:00`
}

/**
 * 解析 UTC+8 的日期/日期时间字符串为时间戳。
 * 支持：`2026-09-27`、`2026/09/27`、`2026-09-27 14:03`、`2026-09-27T14:03:07`、`2026年9月27日`
 * `endOfDay=true` 时，只有日期没有时间的输入会被补成当天 23:59:59.999（用于「截止日期」语义）。
 * 解析失败返回 undefined（不抛异常——LLM 输出不可靠，必须容错）。
 */
export function parseUtc8(input: unknown, endOfDay = false): number | undefined {
  if (input === null || input === undefined) return undefined
  if (typeof input === 'number' && Number.isFinite(input)) {
    // 数值：>1e12 视为毫秒，>1e9 视为秒，否则不可信
    if (input > 1e12) return Math.round(input)
    if (input > 1e9) return Math.round(input * 1000)
    return undefined
  }
  if (typeof input !== 'string') return undefined
  const s = input.trim()
  if (!s || /^(无|未知|未定|待定|不详|null|none|n\/a|-)+$/i.test(s)) return undefined

  const m = s.match(
    /^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?(?:[ T]+(\d{1,2})\s*[:时点]\s*(\d{1,2})(?:\s*[:分]\s*(\d{1,2}))?\s*秒?)?/
  )
  if (!m) return undefined

  const [, y, mo, d, hh, mm, ss] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined

  const hasTime = hh !== undefined
  const hour = hasTime ? Number(hh) : endOfDay ? 23 : 0
  const minute = hasTime ? Number(mm) : endOfDay ? 59 : 0
  const second = hasTime ? Number(ss ?? 0) : endOfDay ? 59 : 0
  const ms = endOfDay && !hasTime ? 999 : 0

  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, ms) - TZ_OFFSET_MS
  return epoch
}

/** 当天 00:00:00.000（UTC+8） */
export function startOfUtc8Day(ts: number): number {
  const p = utc8Parts(ts)
  return Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0) - TZ_OFFSET_MS
}

/** 当天 23:59:59.999（UTC+8） */
export function endOfUtc8Day(ts: number): number {
  return startOfUtc8Day(ts) + 24 * 3600 * 1000 - 1
}

/** 相对当前时间的可读描述：`还剩 3 天` / `已过期 2 小时` */
export function humanizeRemaining(target: number, now = Date.now()): string {
  if (!target) return ''
  const diff = target - now
  const abs = Math.abs(diff)
  const day = 24 * 3600 * 1000
  const hour = 3600 * 1000
  const minute = 60 * 1000

  let text: string
  if (abs >= day) text = `${Math.floor(abs / day)} 天`
  else if (abs >= hour) text = `${Math.floor(abs / hour)} 小时`
  else if (abs >= minute) text = `${Math.floor(abs / minute)} 分钟`
  else text = '不到 1 分钟'

  return diff >= 0 ? `还剩 ${text}` : `已过 ${text}`
}

/** 两个时间区间是否重叠（用于任务去重辅助判断） */
export function rangesOverlap(
  aStart?: number,
  aEnd?: number,
  bStart?: number,
  bEnd?: number
): boolean {
  // 缺边界的按无穷处理
  const aS = aStart ?? Number.NEGATIVE_INFINITY
  const aE = aEnd ?? Number.POSITIVE_INFINITY
  const bS = bStart ?? Number.NEGATIVE_INFINITY
  const bE = bEnd ?? Number.POSITIVE_INFINITY
  return aS <= bE && bS <= aE
}
