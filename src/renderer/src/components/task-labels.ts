/**
 * 任务字段的统一文案（缩略图 / 详情页共用）
 * ------------------------------------------------------------------
 * 需求（README_UPDATE_NEW.md §2.2 + 边界补充）原文：
 *   「需要在缩略模式下显示任务的接头人、负责人（分开两行写），以及起止时间。
 *     如果这些没有被明确，也应该在缩略状态下告知用户没有明确信息，统一文案为：
 *       - 接头人：未明确
 *       - 负责人：未明确
 *       - 时间：未明确起止时间」
 *
 * 为什么把这些文案单独抽出来：
 *   缩略图（TaskTile）和详情页（TaskDetail）都要展示同样的三个字段，
 *   如果两边各写各的，日后改文案必然漏掉一处，用户就会看到两套说法。
 *   这里作为**唯一来源**，两边都从这里取。
 *
 * 注意「时间」的文案规则（需求原句）：
 *   两个时间都没有 → `未明确起止时间`；
 *   只有一个时间 → 显示已有的那个（如「09-30 截止」或「09-30 起」）。
 *   所以 `未明确起止时间` 只在两端都缺失时出现，不能一概而论。
 */
import type { Task } from '@shared/types'
import { utc8Parts } from '@shared/time'

/* ------------------------------------------------------------------ */
/* 统一文案常量                                                        */
/* ------------------------------------------------------------------ */

/** 接头人缺失时的统一文案（§2.2） */
export const LABEL_UNKNOWN_CONTACT = '未明确'

/**
 * 负责人缺失时的统一文案（§2.2）。
 * 与接头人当前取值相同，但**单独定义**——两者语义不同，
 * 需求若日后分别调整措辞（如「未指定负责人」），改一处即可，不会互相牵连。
 */
export const LABEL_UNKNOWN_ORGANIZER = '未明确'

/** 起止时间两端都缺失时的统一文案（§2.2） */
export const LABEL_UNKNOWN_TIME = '未明确起止时间'

/**
 * 任务名称缺失时的统一文案。
 * 场景：手动新建的任务（第二次更新需求 §1a）用户还没填名称就保存了。
 * 与其它字段口径一致，同样用「未明确」。
 */
export const LABEL_UNKNOWN_NAME = '未明确'

/* ------------------------------------------------------------------ */
/* 取值辅助                                                            */
/* ------------------------------------------------------------------ */

/** 判定一个时间戳是否「真的存在」（0 / NaN / 负数都当作没提供） */
function hasTime(ts: number | undefined | null): ts is number {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 月-日（UTC+8，年份省略）。
 * 磁贴空间非常有限，只保留 `09-30` 这种最关键的信息；
 * 需求原文给的示例也正是「09-30 截止」这一粒度。
 */
function monthDay(ts: number): string {
  const p = utc8Parts(ts)
  return `${pad(p.month)}-${pad(p.day)}`
}

/** 任务名称展示文案：有值用它，没有则统一「未明确」 */
export function nameLabel(task: Pick<Task, 'name'>): string {
  const n = task.name?.trim()
  return n ? n : LABEL_UNKNOWN_NAME
}

/** 任务名称是否属于「未明确」（供调用方决定要不要用弱化样式） */
export function isNameUnknown(task: Pick<Task, 'name'>): boolean {
  return !task.name?.trim()
}

/** 接头人展示文案：有值用它，没有则统一「未明确」 */
export function contactLabel(task: Pick<Task, 'contactPerson'>): string {
  const name = task.contactPerson?.trim()
  return name ? name : LABEL_UNKNOWN_CONTACT
}

/** 负责人展示文案：多人用「、」连接，没有则统一「未明确」 */
export function organizerLabel(task: Pick<Task, 'organizers'>): string {
  const list = (task.organizers ?? []).map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list.join('、') : LABEL_UNKNOWN_ORGANIZER
}

/**
 * 起止时间展示文案（磁贴用的紧凑格式）。
 * 规则严格照需求：两端都有 → 起 · 止；只有一端 → 只显示那一端；两端都没有 → 统一文案。
 */
export function timeLabel(task: Pick<Task, 'startAt' | 'endAt'>): string {
  // 先把「无效时间戳」统一收敛成 undefined，后面的分支就不必反复判空
  const startAt = hasTime(task.startAt) ? task.startAt : undefined
  const endAt = hasTime(task.endAt) ? task.endAt : undefined

  if (startAt !== undefined && endAt !== undefined) {
    return `${monthDay(startAt)} 起 · ${monthDay(endAt)} 截止`
  }
  if (endAt !== undefined) return `${monthDay(endAt)} 截止`
  if (startAt !== undefined) return `${monthDay(startAt)} 起`
  return LABEL_UNKNOWN_TIME
}

/** 该任务的时间是否属于「未明确」（供调用方决定要不要用弱化样式） */
export function isTimeUnknown(task: Pick<Task, 'startAt' | 'endAt'>): boolean {
  return !hasTime(task.startAt) && !hasTime(task.endAt)
}

/** 接头人是否属于「未明确」 */
export function isContactUnknown(task: Pick<Task, 'contactPerson'>): boolean {
  return !task.contactPerson?.trim()
}

/** 负责人是否属于「未明确」 */
export function isOrganizerUnknown(task: Pick<Task, 'organizers'>): boolean {
  return (task.organizers ?? []).filter((s) => s.trim()).length === 0
}
