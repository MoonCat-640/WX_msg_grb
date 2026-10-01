/**
 * 演示数据装载
 * ------------------------------------------------------------------
 * 需求「可测试性：提供模拟数据模式，无需真实微信环境即可测试 UI」。
 *
 * 这里把 wechat 层的模拟联系人/消息灌进数据库，让整条链路
 * （会话 → 消息 → 任务抽取 → 磁贴展示）在没有任何真实环境时也能跑通。
 */
import { scoped } from '../core/logger'
import { persistSoon } from '../core/store'
import { insertAccount, listAccounts } from '../data/account-repo'
import { makeConversationId, setSelection, upsertConversations, listConversations } from '../data/conversation-repo'
import { insertMessages } from '../data/message-repo'
import { kvGet, kvSet, KV } from '../data/kv-repo'
import { MOCK_CONTACTS, mockMessages } from '../wechat/mock'
import { normalizeConversation, normalizeMessage } from '../wechat/normalize'

const log = scoped('demo-data')

/** 演示账号的平台账号 id（固定值，重复装载不会产生重复账号） */
export const DEMO_ACCOUNT_ID = 'demo-account-wechat'
const DEMO_PLATFORM_ACCOUNT_ID = 'mock_wxid_demo'

/** 默认勾选多少个会话（太多会拖慢抽取，演示取前 5 个） */
const DEFAULT_SELECTED = 5

/** 确保演示账号存在并返回其 id */
function ensureDemoAccount(): string {
  const existing = listAccounts().find((a) => a.id === DEMO_ACCOUNT_ID)
  if (existing) return existing.id

  const now = Date.now()
  insertAccount({
    id: DEMO_ACCOUNT_ID,
    platform: 'wechat',
    platformAccountId: DEMO_PLATFORM_ACCOUNT_ID,
    displayName: '演示账号（模拟数据）',
    state: 'online',
    loginMethod: 'local-detect',
    detectedLocally: true,
    createdAt: now,
    lastSeenAt: now,
    note: '由「装载演示数据」创建，仅用于界面与流程调试'
  })
  log.info('已创建演示账号')
  return DEMO_ACCOUNT_ID
}

/**
 * 装载演示数据。
 * 幂等：重复调用不会产生重复会话（会话 id 固定）与重复消息（消息 id 固定 + INSERT OR IGNORE）。
 */
export async function seedDemoData(): Promise<{ conversations: number; messages: number }> {
  const accountId = ensureDemoAccount()

  // 1) 会话
  const conversations = MOCK_CONTACTS.map((raw) =>
    normalizeConversation(accountId, 'wechat', raw)
  )
  upsertConversations(conversations)

  // 2) 首次装载时默认勾选前几个会话，省得用户还要手动点一遍
  if (!kvGet<boolean>(KV.mockSeeded, false)) {
    const picked = conversations.slice(0, DEFAULT_SELECTED).map((c) => c.id)
    setSelection(picked, true)
    kvSet(KV.mockSeeded, true)
    log.info('已默认勾选演示会话', { 数量: picked.length })
  }

  // 3) 消息
  let messageCount = 0
  const selected = listConversations({ accountId, onlySelected: true })
  const targets = selected.length > 0 ? selected : conversations

  for (const conv of targets) {
    const raws = mockMessages(conv.platformConversationId)
    if (raws.length === 0) continue
    const messages = raws.map((raw) => normalizeMessage(conv, raw))
    const inserted = insertMessages(messages)
    messageCount += inserted
    log.debug('演示会话消息已写入', { 会话: conv.name, 总数: messages.length, 新增: inserted })
  }

  persistSoon()
  log.info('演示数据装载完成', {
    账号: accountId,
    会话数: conversations.length,
    新增消息: messageCount
  })

  return { conversations: conversations.length, messages: messageCount }
}

/** 演示数据是否已装载（界面据此决定是否显示引导按钮） */
export function isDemoSeeded(): boolean {
  return kvGet<boolean>(KV.mockSeeded, false)
}

export { makeConversationId }
