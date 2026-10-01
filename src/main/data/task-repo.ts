/**
 * 任务仓储
 * ------------------------------------------------------------------
 * 任务是从聊天记录里抽出来的「可执行事项」。
 * 嵌套结构（发布人列表、材料清单、来源消息）以 JSON 文本列存放——
 * 这些字段只整体读写、不需要单独检索，用 JSON 列最简单可靠。
 */
import type { LlmProviderId, Task, TaskMaterial, TaskPublisher, TaskStatus } from '@shared/types'
import { execute, query, queryOne } from '../core/store'
import { scoped } from '../core/logger'
import { statusAfterRestore } from '../tasks/classify'

const log = scoped('task-repo')

interface TaskRow {
  id: string
  name: string
  topic: string | null
  type: string | null
  organizers: string | null
  start_at: number | null
  end_at: number | null
  materials: string | null
  contact_person: string | null
  original_text: string | null
  publishers: string | null
  source_message_ids: string | null
  status: string
  status_locked: number
  deleted: number
  tile_order: number
  fingerprint: string | null
  confidence: number | null
  /** 任务来源：'auto' | 'manual'（第二次更新需求 §1）；老库由迁移补默认值 */
  origin: string | null
  llm_provider: string | null
  llm_model: string | null
  llm_extracted_at: number | null
  llm_batch_id: string | null
  created_at: number
  updated_at: number
}

/** 安全解析 JSON 列，坏数据不炸整个查询 */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw)
    return (v ?? fallback) as T
  } catch {
    return fallback
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic ?? '',
    type: row.type ?? '',
    organizers: parseJson<string[]>(row.organizers, []),
    startAt: row.start_at ?? undefined,
    endAt: row.end_at ?? undefined,
    materials: parseJson<TaskMaterial[]>(row.materials, []),
    contactPerson: row.contact_person ?? undefined,
    originalText: row.original_text ?? '',
    publishers: parseJson<TaskPublisher[]>(row.publishers, []),
    sourceMessageIds: parseJson<string[]>(row.source_message_ids, []),
    status: row.status as TaskStatus,
    statusLocked: row.status_locked === 1,
    deleted: row.deleted === 1,
    tileOrder: row.tile_order,
    fingerprint: row.fingerprint ?? '',
    confidence: row.confidence ?? undefined,
    // 老数据没有该列时视为自动抽取
    origin: row.origin === 'manual' ? 'manual' : 'auto',
    llm: row.llm_provider
      ? {
          provider: row.llm_provider as LlmProviderId,
          model: row.llm_model ?? '',
          extractedAt: row.llm_extracted_at ?? 0,
          batchId: row.llm_batch_id ?? undefined
        }
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listTasks(params: {
  status?: TaskStatus
  keyword?: string
  includeDeleted?: boolean
}): Task[] {
  const where: string[] = []
  const args: (string | number)[] = []

  // 「已删除」是用户主动归入的分类（更新需求 §4），查它时必须绕过 deleted 标志，
  // 否则会得到空列表——这是最容易踩的一个坑。
  // 规则：只有明确要求 includeDeleted、或就是在查 'deleted' 这个分类时，才带上被删除的行。
  const wantDeleted = params.status === 'deleted'
  if (!params.includeDeleted && !wantDeleted) {
    where.push('deleted = 0')
  }
  if (params.status) {
    where.push('status = ?')
    args.push(params.status)
  }
  if (params.keyword && params.keyword.trim()) {
    where.push('(name LIKE ? OR topic LIKE ? OR type LIKE ? OR original_text LIKE ?)')
    const like = `%${params.keyword.trim()}%`
    args.push(like, like, like, like)
  }
  const sql =
    'SELECT * FROM tasks' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY tile_order ASC, updated_at DESC'
  return query<TaskRow>(sql, args).map(rowToTask)
}

export function getTask(id: string): Task | null {
  const row = queryOne<TaskRow>('SELECT * FROM tasks WHERE id = ?', [id])
  return row ? rowToTask(row) : null
}

export function listAllTasksIncludingDeleted(): Task[] {
  return query<TaskRow>('SELECT * FROM tasks ORDER BY updated_at DESC').map(rowToTask)
}

/** 插入新任务 */
export function insertTask(task: Task): Task {
  execute(
    `INSERT INTO tasks
      (id, name, topic, type, organizers, start_at, end_at, materials, contact_person, original_text,
       publishers, source_message_ids, status, status_locked, deleted, tile_order, fingerprint,
       confidence, origin, llm_provider, llm_model, llm_extracted_at, llm_batch_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      task.id,
      task.name,
      task.topic,
      task.type,
      JSON.stringify(task.organizers ?? []),
      task.startAt ?? null,
      task.endAt ?? null,
      JSON.stringify(task.materials ?? []),
      task.contactPerson ?? null,
      task.originalText,
      JSON.stringify(task.publishers ?? []),
      JSON.stringify(task.sourceMessageIds ?? []),
      task.status,
      task.statusLocked ? 1 : 0,
      task.deleted ? 1 : 0,
      task.tileOrder,
      task.fingerprint,
      task.confidence ?? null,
      task.origin ?? 'auto',
      task.llm?.provider ?? null,
      task.llm?.model ?? null,
      task.llm?.extractedAt ?? null,
      task.llm?.batchId ?? null,
      task.createdAt,
      task.updatedAt
    ]
  )
  log.debug('新任务已入库', { 名称: task.name, 状态: task.status })
  return task
}

/** 全量更新任务（合并任务时用） */
export function replaceTask(task: Task): Task {
  execute(
    `UPDATE tasks SET
       name = ?, topic = ?, type = ?, organizers = ?, start_at = ?, end_at = ?, materials = ?,
       contact_person = ?, original_text = ?, publishers = ?, source_message_ids = ?, status = ?,
       status_locked = ?, deleted = ?, tile_order = ?, fingerprint = ?, confidence = ?, origin = ?,
       llm_provider = ?, llm_model = ?, llm_extracted_at = ?, llm_batch_id = ?, updated_at = ?
     WHERE id = ?`,
    [
      task.name,
      task.topic,
      task.type,
      JSON.stringify(task.organizers ?? []),
      task.startAt ?? null,
      task.endAt ?? null,
      JSON.stringify(task.materials ?? []),
      task.contactPerson ?? null,
      task.originalText,
      JSON.stringify(task.publishers ?? []),
      JSON.stringify(task.sourceMessageIds ?? []),
      task.status,
      task.statusLocked ? 1 : 0,
      task.deleted ? 1 : 0,
      task.tileOrder,
      task.fingerprint,
      task.confidence ?? null,
      task.origin ?? 'auto',
      task.llm?.provider ?? null,
      task.llm?.model ?? null,
      task.llm?.extractedAt ?? null,
      task.llm?.batchId ?? null,
      task.updatedAt,
      task.id
    ]
  )
  return task
}

/** 局部更新（状态、磁贴顺序等） */
export function patchTask(id: string, patch: Partial<Task>): Task | null {
  const current = getTask(id)
  if (!current) return null
  const next: Task = { ...current, ...patch, id, updatedAt: Date.now() }
  replaceTask(next)
  return next
}

/**
 * 删除任务 = **移入「已删除」分类**（更新需求 §4）。
 *
 * 注意这里不再物理删除：用户点「删除」通常只是"这事不该我做"，
 * 因此先归到「已删除」留个后悔药；要真删得在「已删除」分类里长按并二次确认。
 * 同时把 deleted 标志置 1，让常规列表查询自动过滤掉它。
 */
export function softDeleteTask(id: string): void {
  execute(
    `UPDATE tasks SET status = 'deleted', deleted = 1, status_locked = 0, updated_at = ? WHERE id = ?`,
    [Date.now(), id]
  )
  execute('DELETE FROM tile_layouts WHERE task_id = ?', [id])
  log.info('任务已移入「已删除」分类', { id })
}

/**
 * 从「已删除」恢复：按起止时间重新归类，**不直接扔回「进行中」**（更新需求 §4 边界）。
 * statusAfterRestore 复用与自动分类完全相同的规则，保证口径一致。
 */
export function restoreTask(id: string): Task | null {
  const current = getTask(id)
  if (!current) return null

  const next = statusAfterRestore(
    { startAt: current.startAt, endAt: current.endAt, status: 'ongoing', statusLocked: false },
    Date.now()
  )
  execute('UPDATE tasks SET deleted = 0, status = ?, status_locked = 0, updated_at = ? WHERE id = ?', [
    next,
    Date.now(),
    id
  ])
  log.info('任务已从「已删除」恢复', { id, 归入分类: next })
  return getTask(id)
}

/** 彻底删除（连数据库记录一起删）——只在「已删除」分类里经过二次确认后调用 */
export function hardDeleteTask(id: string): void {
  execute('DELETE FROM tile_layouts WHERE task_id = ?', [id])
  execute('DELETE FROM tasks WHERE id = ?', [id])
  log.warn('任务已被彻底删除（不可恢复）', { id })
}

/** 按分类批量移入「已删除」（多选模式的批量删除） */
export function batchSoftDelete(ids: string[]): number {
  if (ids.length === 0) return 0
  const ph = ids.map(() => '?').join(',')
  execute(
    `UPDATE tasks SET status = 'deleted', deleted = 1, status_locked = 0, updated_at = ? WHERE id IN (${ph})`,
    [Date.now(), ...ids]
  )
  execute(`DELETE FROM tile_layouts WHERE task_id IN (${ph})`, ids)
  log.info('批量移入「已删除」', { 数量: ids.length })
  return ids.length
}

/** 批量彻底删除 */
export function batchHardDelete(ids: string[]): number {
  if (ids.length === 0) return 0
  const ph = ids.map(() => '?').join(',')
  execute(`DELETE FROM tile_layouts WHERE task_id IN (${ph})`, ids)
  execute(`DELETE FROM tasks WHERE id IN (${ph})`, ids)
  log.warn('批量彻底删除', { 数量: ids.length })
  return ids.length
}

/**
 * 一键清除某个分类下的全部任务（更新需求 §3）。
 * hardDelete=true 时是真删（「已删除」分类用），否则移入「已删除」。
 * **只动 tasks 表，绝不影响账号、API Key 与其它分类。**
 */
export function clearCategory(status: TaskStatus, hardDelete: boolean): number {
  const rows = query<{ id: string }>('SELECT id FROM tasks WHERE status = ?', [status])
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return 0
  if (hardDelete) return batchHardDelete(ids)
  return batchSoftDelete(ids)
}

/** 只更新状态字段（自动分类时高频调用，避免整行重写） */
export function updateStatus(id: string, status: TaskStatus, locked?: boolean): void {
  if (locked === undefined) {
    execute('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id])
  } else {
    execute('UPDATE tasks SET status = ?, status_locked = ?, updated_at = ? WHERE id = ?', [
      status,
      locked ? 1 : 0,
      Date.now(),
      id
    ])
  }
}

/** 取所有未锁定状态的任务（自动分类只处理这些） */
export function listUnlockedTasks(): Task[] {
  return query<TaskRow>('SELECT * FROM tasks WHERE status_locked = 0 AND deleted = 0').map(rowToTask)
}

/** 按状态统计数量（左侧类别栏的角标） */
export function countByStatus(): Record<TaskStatus, number> {
  const rows = query<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
  const out: Record<TaskStatus, number> = {
    ongoing: 0,
    upcoming: 0,
    done: 0,
    expired: 0,
    deleted: 0
  }
  for (const r of rows) {
    if (r.status in out) out[r.status as TaskStatus] = r.n
  }
  return out
}

/**
 * 取「全部任务」作为去重候选（**含已删除**）。
 *
 * 更新需求 §5 边界要求：比对范围要覆盖进行中/未开始/已完成/已过期/已删除所有分类。
 * 之前只比未删除的，导致「已完成」的任务在下一轮同步时又被当成新任务插了一条。
 */
export function listTasksForDedup(): { id: string; fingerprint: string; features: Task; status: TaskStatus; createdAt: number }[] {
  const rows = query<TaskRow>('SELECT * FROM tasks ORDER BY created_at ASC')
  return rows.map((r) => {
    const t = rowToTask(r)
    return { id: t.id, fingerprint: t.fingerprint, features: t, status: t.status, createdAt: t.createdAt }
  })
}

/** 取指纹 → 任务 的映射，供去重比对使用 */
export function listFingerprints(): { id: string; fingerprint: string; name: string; endAt?: number; startAt?: number }[] {
  const rows = query<TaskRow>(
    'SELECT id, fingerprint, name, start_at, end_at FROM tasks WHERE deleted = 0'
  )
  return rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint ?? '',
    name: r.name,
    startAt: r.start_at ?? undefined,
    endAt: r.end_at ?? undefined
  }))
}

export function clearAllTasks(): void {
  execute('DELETE FROM tile_layouts')
  execute('DELETE FROM tasks')
}

/**
 * 一次性数据迁移：把旧版本"软删除"的任务归入新的「已删除」分类。
 *
 * 背景：更新需求 §4 之前，删除是「把 deleted 标志置 1」，status 保持原值；
 * 现在删除改成「status = 'deleted'」，而列表查询对非 deleted 分类会过滤掉
 * deleted = 1 的行。两者叠加会让**旧数据里已删除的任务在任何标签页都看不到**。
 *
 * 这个迁移是幂等的（只影响 status 还不是 'deleted' 的行），每次启动跑一遍没有副作用。
 * 返回迁移的条数，便于日志说明。
 */
export function migrateLegacyDeletedTasks(): number {
  const before = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE deleted = 1 AND status <> 'deleted'`
  )
  const n = before?.n ?? 0
  if (n > 0) {
    execute(`UPDATE tasks SET status = 'deleted' WHERE deleted = 1 AND status <> 'deleted'`)
    log.warn('已把旧版本软删除的任务归入「已删除」分类', { 迁移条数: n })
  }
  return n
}
