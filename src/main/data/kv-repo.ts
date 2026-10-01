/**
 * 通用键值仓储
 * ------------------------------------------------------------------
 * 用于存放不需要单独建表的零散状态（如：上次同步时间、演示数据已初始化标记）。
 * 值统一按 JSON 序列化，读取时做类型兜底。
 */
import { execute, queryOne } from '../core/store'

export function kvGet<T>(key: string, fallback: T): T {
  const row = queryOne<{ v: string }>('SELECT v FROM kv WHERE k = ?', [key])
  if (!row) return fallback
  try {
    return JSON.parse(row.v) as T
  } catch {
    return fallback
  }
}

export function kvSet(key: string, value: unknown): void {
  execute('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [
    key,
    JSON.stringify(value ?? null)
  ])
}

export function kvDelete(key: string): void {
  execute('DELETE FROM kv WHERE k = ?', [key])
}

/** 常用的键名集中在这里，避免各处写错字符串 */
export const KV = {
  /** 上次成功同步完成的时间（epoch ms） */
  lastSyncAt: 'sync.lastCompletedAt',
  /** 演示数据是否已写入 */
  mockSeeded: 'mock.seeded',
  /** 每个会话已读取到的最新消息时间 */
  convCursor: (conversationId: string) => `sync.cursor.${conversationId}`
} as const
