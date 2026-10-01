/**
 * 消息仓储
 * ------------------------------------------------------------------
 * 消息是「原始素材」——LLM 从这里读，任务从消息里抽出来。
 *
 * 两个关键设计：
 *   1. 写入用 INSERT OR IGNORE：同一条消息重复读到不会产生副本
 *   2. 有保留策略（prune）：控制数据库体积，避免整库加密落盘越来越慢
 */
import type { Attachment, ChatMessage, MessageKind } from '@shared/types'
import { execute, query, queryOne, transaction } from '../core/store'
import { scoped } from '../core/logger'

const log = scoped('msg-repo')

interface MsgRow {
  id: string
  conversation_id: string
  account_id: string
  platform_message_id: string
  sender_id: string | null
  sender_name: string | null
  is_self: number
  kind: string
  text: string | null
  media_path: string | null
  timestamp: number
  /** JSON Attachment[]（文件/链接正文）；老库可能是 NULL */
  attachments: string | null
  raw: string | null
}

function rowToMessage(row: MsgRow): ChatMessage {
  // 附件列是后加的（见 store.ts 的迁移）。解析失败时按"没有附件"处理，
  // 不能因为一条坏数据让整个会话读不出来。
  let attachments: Attachment[] | undefined
  if (row.attachments) {
    try {
      const parsed = JSON.parse(row.attachments)
      if (Array.isArray(parsed) && parsed.length > 0) attachments = parsed as Attachment[]
    } catch {
      attachments = undefined
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    accountId: row.account_id,
    platformMessageId: row.platform_message_id,
    senderId: row.sender_id ?? '',
    senderName: row.sender_name ?? '',
    isSelf: row.is_self === 1,
    kind: row.kind as MessageKind,
    text: row.text ?? '',
    mediaPath: row.media_path ?? undefined,
    attachments,
    timestamp: row.timestamp
  }
}

/**
 * 批量写入消息，返回真正新增的条数。
 * 用 INSERT OR IGNORE 保证幂等——同步服务可以放心重复调用。
 */
export function insertMessages(list: ChatMessage[]): number {
  if (list.length === 0) return 0
  let inserted = 0
  transaction(() => {
    for (const m of list) {
      const attachmentsJson =
        m.attachments && m.attachments.length > 0 ? JSON.stringify(m.attachments) : null
      execute(
        `INSERT OR IGNORE INTO messages
           (id, conversation_id, account_id, platform_message_id, sender_id, sender_name,
            is_self, kind, text, media_path, timestamp, attachments, raw)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          m.id,
          m.conversationId,
          m.accountId,
          m.platformMessageId,
          m.senderId || null,
          m.senderName || null,
          m.isSelf ? 1 : 0,
          m.kind,
          m.text ?? '',
          m.mediaPath ?? null,
          m.timestamp,
          attachmentsJson,
          m.raw === undefined ? null : JSON.stringify(m.raw)
        ]
      )
      // changes() 反映上一次 INSERT 是否真的插入了行
      const changed = queryOne<{ c: number }>('SELECT changes() AS c')
      const n = changed?.c ?? 0
      inserted += n
      // 已存在、但当时还没有附件正文的旧行：把这次抓到的附件补上去。
      // 否则「附件读取」上线之前入库的消息会永远缺正文（ON CONFLICT 的补写代价太高，
      // 这里只在确实有附件时补一次）。
      if (n === 0 && attachmentsJson) {
        execute('UPDATE messages SET attachments = ? WHERE id = ? AND attachments IS NULL', [
          attachmentsJson,
          m.id
        ])
      }
    }
  })
  return inserted
}

/** 查询某个会话的消息（按时间升序，方便直接喂给 LLM） */
export function listMessages(params: {
  conversationId: string
  from?: number
  to?: number
  limit?: number
  offset?: number
  keyword?: string
}): ChatMessage[] {
  const where = ['conversation_id = ?']
  const args: (string | number)[] = [params.conversationId]
  if (params.from !== undefined) {
    where.push('timestamp >= ?')
    args.push(params.from)
  }
  if (params.to !== undefined) {
    where.push('timestamp <= ?')
    args.push(params.to)
  }
  if (params.keyword && params.keyword.trim()) {
    where.push('text LIKE ?')
    args.push(`%${params.keyword.trim()}%`)
  }
  const limit = Math.min(params.limit ?? 500, 5000)
  const offset = params.offset ?? 0

  const rows = query<MsgRow>(
    `SELECT * FROM messages WHERE ${where.join(' AND ')}
     ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
    [...args, limit, offset]
  )
  return rows.map(rowToMessage)
}

/** 取最近 N 条（按时间升序返回，便于直接拼 LLM 输入） */
export function listRecentMessages(conversationId: string, limit: number): ChatMessage[] {
  const rows = query<MsgRow>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE conversation_id = ?
       ORDER BY timestamp DESC LIMIT ?
     ) ORDER BY timestamp ASC`,
    [conversationId, limit]
  )
  return rows.map(rowToMessage)
}

/**
 * 从给定消息 id 里挑出「已经存过附件正文」的那些。
 *
 * 用途：同步每轮都会重新拉到同一批历史消息，若不跳过已抓过的，
 * 就会反复读同一个本地文件、反复抓同一个网页（实测每轮上千次请求）。
 * SQLite 的变量数有上限，故分批查询。
 */
export function idsWithAttachments(ids: string[]): Set<string> {
  const out = new Set<string>()
  if (ids.length === 0) return out
  const CHUNK = 400
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = query<{ id: string }>(
      `SELECT id FROM messages WHERE attachments IS NOT NULL AND id IN (${placeholders})`,
      chunk
    )
    for (const r of rows) out.add(r.id)
  }
  return out
}

export function countMessages(conversationId: string): number {  const row = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
    [conversationId]
  )
  return row?.n ?? 0
}

/** 某会话最新一条消息的时间（用于增量同步） */
export function latestTimestamp(conversationId: string): number | null {
  const row = queryOne<{ t: number | null }>(
    'SELECT MAX(timestamp) AS t FROM messages WHERE conversation_id = ?',
    [conversationId]
  )
  return row?.t ?? null
}

/** 全局统计（界面顶栏与设置页展示） */
export function messageStats(): { total: number; conversations: number; earliest: number | null; latest: number | null } {
  const row = queryOne<{ n: number; c: number; e: number | null; l: number | null }>(
    'SELECT COUNT(*) AS n, COUNT(DISTINCT conversation_id) AS c, MIN(timestamp) AS e, MAX(timestamp) AS l FROM messages'
  )
  return {
    total: row?.n ?? 0,
    conversations: row?.c ?? 0,
    earliest: row?.e ?? null,
    latest: row?.l ?? null
  }
}

/**
 * 保留策略：删除每个会话中超过 keepPerConversation 条的旧消息。
 * 目的：控制加密数据库体积（整库加密落盘，体积越大越慢）。
 * 返回删除条数。
 */
export function pruneMessages(keepPerConversation = 3000): number {
  const before = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n ?? 0
  execute(
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM messages m WHERE (
         SELECT COUNT(*) FROM messages m2
         WHERE m2.conversation_id = m.conversation_id AND m2.timestamp >= m.timestamp
       ) > ?
     )`,
    [keepPerConversation]
  )
  const after = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n ?? 0
  const removed = before - after
  if (removed > 0) {
    log.info('已按保留策略清理旧消息', { 删除条数: removed, 每会话保留: keepPerConversation })
  }
  return removed
}

/** 删除某会话的全部消息 */
export function deleteMessagesOf(conversationId: string): void {
  execute('DELETE FROM messages WHERE conversation_id = ?', [conversationId])
}

/** 清空全部消息（演示数据重置用） */
export function clearAllMessages(): void {
  execute('DELETE FROM messages')
}
