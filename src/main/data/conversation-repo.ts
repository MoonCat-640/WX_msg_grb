/**
 * 会话（联系人 / 群聊）仓储
 * ------------------------------------------------------------------
 * 「会话」是聊天记录的容器：一个微信联系人、一个微信群、一个 QQ 好友…
 * 用户勾选（selected=1）后，同步服务才会去读它的消息。
 */
import type { Conversation, ConversationKind, PlatformId } from '@shared/types'
import { execute, query, queryOne, transaction } from '../core/store'
import { scoped } from '../core/logger'

const log = scoped('conv-repo')

interface ConvRow {
  id: string
  account_id: string
  platform: string
  platform_conversation_id: string
  kind: string
  name: string
  remark: string | null
  nickname: string | null
  member_count: number | null
  last_message_at: number | null
  selected: number
  cached_count: number
}

function rowToConversation(row: ConvRow): Conversation {
  return {
    id: row.id,
    accountId: row.account_id,
    platform: row.platform as PlatformId,
    platformConversationId: row.platform_conversation_id,
    kind: row.kind as ConversationKind,
    name: row.name,
    remark: row.remark ?? undefined,
    nickname: row.nickname ?? undefined,
    memberCount: row.member_count ?? undefined,
    lastMessageAt: row.last_message_at ?? undefined,
    selected: row.selected === 1,
    cachedMessageCount: row.cached_count
  }
}

/** 该会话在本应用中的稳定 id */
export function makeConversationId(accountId: string, platformConversationId: string): string {
  return `${accountId}:${platformConversationId}`
}

export function listConversations(params: {
  accountId?: string
  keyword?: string
  kind?: ConversationKind
  onlySelected?: boolean
}): Conversation[] {
  const where: string[] = []
  const args: (string | number)[] = []

  if (params.accountId) {
    where.push('account_id = ?')
    args.push(params.accountId)
  }
  if (params.kind) {
    where.push('kind = ?')
    args.push(params.kind)
  }
  if (params.onlySelected) {
    where.push('selected = 1')
  }
  if (params.keyword && params.keyword.trim()) {
    where.push('(name LIKE ? OR remark LIKE ? OR nickname LIKE ? OR platform_conversation_id LIKE ?)')
    const like = `%${params.keyword.trim()}%`
    args.push(like, like, like, like)
  }

  const sql =
    'SELECT * FROM conversations' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY last_message_at DESC NULLS LAST, name ASC'

  return query<ConvRow>(sql, args).map(rowToConversation)
}

export function getConversation(id: string): Conversation | null {
  const row = queryOne<ConvRow>('SELECT * FROM conversations WHERE id = ?', [id])
  return row ? rowToConversation(row) : null
}

/**
 * 批量 upsert 会话（同步时调用）。
 * 注意：**不覆盖用户已有的 selected 选择**——否则每次刷新会话列表都会清掉用户的勾选。
 */
export function upsertConversations(list: Conversation[]): number {
  if (list.length === 0) return 0
  let n = 0
  transaction(() => {
    for (const c of list) {
      execute(
        `INSERT INTO conversations
           (id, account_id, platform, platform_conversation_id, kind, name, remark, nickname,
            member_count, last_message_at, selected, cached_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,0)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           remark = excluded.remark,
           nickname = excluded.nickname,
           member_count = COALESCE(excluded.member_count, conversations.member_count),
           last_message_at = COALESCE(excluded.last_message_at, conversations.last_message_at),
           kind = excluded.kind`,
        [
          c.id,
          c.accountId,
          c.platform,
          c.platformConversationId,
          c.kind,
          c.name,
          c.remark ?? null,
          c.nickname ?? null,
          c.memberCount ?? null,
          c.lastMessageAt ?? null
        ]
      )
      n++
    }
  })
  log.info('会话列表已更新', { 数量: n })
  return n
}

/** 设置选中状态 */
export function setSelection(ids: string[], selected: boolean): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(',')
  execute(`UPDATE conversations SET selected = ? WHERE id IN (${placeholders})`, [
    selected ? 1 : 0,
    ...ids
  ])
  log.info(selected ? '已勾选会话' : '已取消勾选', { 数量: ids.length })
  return ids.length
}

/** 列出所有被勾选（需要读取）的会话 */
export function listSelected(accountId?: string): Conversation[] {
  return listConversations({ accountId, onlySelected: true })
}

/** 更新某会话已缓存的消息条数（同步完成后回填，用于界面展示） */
export function updateCachedCount(conversationId: string, count: number): void {
  execute('UPDATE conversations SET cached_count = ? WHERE id = ?', [count, conversationId])
}

/** 删除某账号下已经不在上游列表里的会话（上游删了好友/退群） */
export function removeConversationsNotIn(accountId: string, keepIds: string[]): number {
  if (keepIds.length === 0) return 0
  const placeholders = keepIds.map(() => '?').join(',')
  const before = query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM conversations WHERE account_id = ?',
    [accountId]
  )[0]?.n ?? 0
  // 级联删除消息，避免留下孤立数据
  execute(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT id FROM conversations WHERE account_id = ? AND id NOT IN (${placeholders})
     )`,
    [accountId, ...keepIds]
  )
  execute(`DELETE FROM conversations WHERE account_id = ? AND id NOT IN (${placeholders})`, [
    accountId,
    ...keepIds
  ])
  const after = query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM conversations WHERE account_id = ?',
    [accountId]
  )[0]?.n ?? 0
  const removed = before - after
  if (removed > 0) log.info('清理了上游已不存在的会话', { accountId, 数量: removed })
  return removed
}

export function countConversations(accountId?: string): number {
  const row = accountId
    ? queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE account_id = ?', [
        accountId
      ])
    : queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')
  return row?.n ?? 0
}
