/**
 * 聊天记录同步服务
 * ------------------------------------------------------------------
 * 需求「模块 4：聊天记录读取」：
 *   - 调用 wechat_exp 提取密钥并解密数据库
 *   - 读取选中对象的名称、备注、聊天记录
 *   - 实时更新：定时轮询（如每 30 秒）调用一次解密和读取
 *
 * 职责边界：本文件是「微信数据」与「本应用」之间唯一的编排者。
 *   上游细节（HTTP 端点、SSE、字段映射）都封装在 src/main/wechat/ 里，
 *   这里只负责「什么时候调、按什么顺序调、结果怎么落库」。
 *
 * 三种后端（由 probe() 判定）：
 *   - wechat-exp-service：启动了 wechat_exp serve，走 HTTP API（首选）
 *   - mock              ：模拟数据模式，不依赖任何真实环境（开发/演示用）
 *   - none              ：既没有 exe 也没开模拟模式，界面给出引导
 */
import type {
  Account,
  ChatMessage,
  Conversation,
  PlatformId,
  SyncProgress,
  SyncState
} from '@shared/types'
import type { SyncProbeResult } from '@shared/ipc'
import { errors } from '../core/errors'
import { scoped } from '../core/logger'
import { getSettings } from '../core/settings'
import { persistSoon } from '../core/store'
import { listAccounts } from '../data/account-repo'
import {
  makeConversationId,
  listConversations,
  listSelected,
  removeConversationsNotIn,
  updateCachedCount,
  upsertConversations
} from '../data/conversation-repo'
import { countMessages, insertMessages, pruneMessages } from '../data/message-repo'
import { kvGet, kvSet, KV } from '../data/kv-repo'
import { extractTasks } from '../tasks/extractor'
import { reclassifyAll } from '../tasks/status'
import { normalizeConversation, normalizeMessage } from '../wechat/normalize'
import { MOCK_CONTACTS, mockMessages } from '../wechat/mock'
import { locateWechatExp, readVersion } from '../wechat/exe-locator'
import { ensureService, getHealth, stopService } from '../wechat/service'
import { getAllMessages, scanAccounts } from '../wechat/client'

const log = scoped('sync')

/**
 * 每个会话「向下游拉取」与「在库里保留」的消息量。
 *
 * ⚠️ 不变式：`MAX_FETCH_PAGES * 200 <= KEEP_PER_CONVERSATION`
 *
 * 为什么必须满足：wechat_exp 的 /api/messages 第 1 页是最新、页码越大越旧，
 * 每页 200 条。若拉取窗口**大于**保留窗口，就会出现这样的死循环：
 *   每轮把 6000 条最新消息拉回来 → 入库（其中约 3000 条上一轮刚被清理掉）
 *   → prune 又把这 3000 条删掉 → 下一轮继续拉、继续删……
 * 实测这个抖动让每轮同步多出约 3000 次插入 + 3000 次删除，并且每次写库
 * 都要把整个数据库重新 AES 加密一遍，单轮耗时 40 秒（比 30 秒的同步间隔还长）。
 */
const MAX_FETCH_PAGES = 12 // 12 × 200 = 2400 条
const KEEP_PER_CONVERSATION = 3000

/** 同步后端类型 */
export type SyncBackend = 'wechat-exp-service' | 'wechat-exp-cli' | 'mock' | 'none'

/** 探针结果的类型来自共享 IPC 契约，保证主进程与界面看到的是同一个形状 */
export type { SyncProbeResult }

/* ------------------------------------------------------------------ */
/* 运行期状态                                                          */
/* ------------------------------------------------------------------ */

let backend: SyncBackend = 'none'
let timer: NodeJS.Timeout | null = null
let running = false
let roundInFlight = false
let mockRound = 0

let progress: SyncProgress = {
  state: 'idle',
  message: '尚未开始同步',
  messagesRead: 0,
  updatedAt: Date.now()
}

/** 进度变更回调（由 IPC 层注册，用于推送给界面） */
type ProgressListener = (p: SyncProgress) => void
let progressListener: ProgressListener | null = null

export function setProgressListener(fn: ProgressListener | null): void {
  progressListener = fn
}

function setProgress(patch: Partial<SyncProgress>): SyncProgress {
  progress = { ...progress, ...patch, updatedAt: Date.now() }
  try {
    progressListener?.(progress)
  } catch (e) {
    log.warn('推送同步进度失败', { error: String(e) })
  }
  return progress
}

export function getSyncStatus(): SyncProgress {
  return { ...progress }
}

export function getBackend(): SyncBackend {
  return backend
}

/* ------------------------------------------------------------------ */
/* 环境探针                                                            */
/* ------------------------------------------------------------------ */

/**
 * 探测当前可用的数据来源。
 * 界面在「设置」与「同步」页面都会展示这个结果，方便用户知道为什么读不到数据。
 */
export async function probe(): Promise<SyncProbeResult> {
  const settings = getSettings()
  const notes: string[] = []

  // 先回收上次运行可能遗留的 wechat_exp 子进程。
  // 强杀/崩溃时退出清理跑不到，子进程会变成孤儿一直占内存；这里精确回收
  // （只认我们自己记录过的 PID + 可执行文件路径，不会误伤用户自己开的 wechat_exp）。
  try {
    const { reclaimOrphanedChild } = await import('../wechat/service')
    reclaimOrphanedChild()
  } catch (e) {
    log.warn('回收遗留的 wechat_exp 子进程失败（不影响使用）', { error: String(e) })
  }

  const located = locateWechatExp()
  const exeFound = located.path !== ''
  let exeVersion: string | undefined
  if (exeFound) {
    const v = await readVersion(located.path).catch(() => null)
    exeVersion = v ?? undefined
    notes.push(`已找到 wechat_exp：${located.path}${v ? `（版本 ${v}）` : ''}`)
  } else {
    notes.push(
      '未找到 wechat_exp.exe。请把它放到软件目录或 tools 子目录，或在「设置」里手动指定路径。'
    )
  }

  const health = getHealth()
  const serviceRunning = health.running

  // 决定后端优先级：模拟模式 > 活跃服务 > 有 exe（可启动）> 无
  if (settings.mockMode) {
    backend = 'mock'
    notes.push('当前处于「模拟数据模式」，不会读取真实微信数据。')
  } else if (serviceRunning) {
    backend = 'wechat-exp-service'
  } else if (exeFound) {
    backend = 'wechat-exp-service'
    notes.push('wechat_exp 服务尚未启动，执行同步时会自动启动。')
  } else {
    backend = 'none'
  }

  return {
    exeFound,
    exePath: exeFound ? located.path : undefined,
    exeVersion,
    serviceRunning,
    servicePort: health.running ? health.port : undefined,
    dbStorageDir: settings.dbStorageDir || undefined,
    backend,
    notes
  }
}

/* ------------------------------------------------------------------ */
/* 本机账号识别                                                        */
/* ------------------------------------------------------------------ */

/**
 * 通过 wechat_exp 扫描本机已登录的微信账号，或扫描本机 QQ 数据库。
 * 注意：这里只负责「发现」，落库由 platform-service 完成。
 *
 * 更新需求 §2.3：QQ 走本地数据库扫描（不用登录接口），
 * 提取后的操作流程与微信完全相同——所以上层调用方不需要区分平台。
 */
export async function detectLocalAccounts(platform: PlatformId): Promise<Account[]> {
  const settings = getSettings()

  if (settings.mockMode) {
    const now = Date.now()
    return [
      {
        id: `mock-account-${platform}`,
        platform,
        platformAccountId: platform === 'qq' ? '10001' : 'mock_wxid_demo',
        displayName: platform === 'qq' ? '演示 QQ 账号（模拟数据）' : '演示账号（模拟数据）',
        state: 'online',
        loginMethod: 'local-detect',
        detectedLocally: true,
        dbStorageDir: '（模拟数据模式，未读取真实目录）',
        createdAt: now,
        lastSeenAt: now,
        note: '模拟数据模式自动创建'
      }
    ]
  }

  // ---- QQ：扫描本机 nt_msg.db（更新需求 §2.3）----
  if (platform === 'qq') {
    const { scanQqDatabases } = await import('../qq')
    const dbs = scanQqDatabases()
    const now = Date.now()
    return dbs.map((d) => ({
      id: `qq-${d.qq}`,
      platform: 'qq' as PlatformId,
      platformAccountId: d.qq,
      displayName: `QQ ${d.qq}`,
      state: 'online' as const,
      loginMethod: 'manual-key' as const,
      detectedLocally: true,
      dbStorageDir: d.path,
      createdAt: now,
      lastSeenAt: now,
      note: `本机数据库 ${d.sizeMb.toFixed(1)} MB（还需提供密钥才能读取）`
    }))
  }

  // ---- 微信：通过 wechat_exp 扫描 ----
  const located = locateWechatExp()
  if (!located.path) {
    throw errors.notReady(
      '未找到 wechat_exp.exe，无法识别本机微信账号',
      '请把 wechat_exp.exe 放到软件目录，或在「设置 → 数据来源」中指定路径'
    )
  }

  const health = await ensureService({ dbDir: settings.dbStorageDir || undefined })
  const accounts = await scanAccounts(health.port)

  const now = Date.now()
  return accounts.map((a, i) => ({
    id: `wechat-${a.wxid || i}`,
    platform: 'wechat' as PlatformId,
    platformAccountId: a.wxid || `account_${i}`,
    displayName: a.wxid || `微信账号 ${i + 1}`,
    state: 'online' as const,
    loginMethod: 'local-detect' as const,
    detectedLocally: true,
    dbStorageDir: a.db_path,
    createdAt: now,
    lastSeenAt: now,
    note: `${a.db_count ?? '?'} 个数据库 / ${a.size_mb ?? '?'} MB`
  }))
}

/** 取某个 QQ 账号对应的数据库路径与密钥（密钥来自保险库） */
async function resolveQqSource(accountId: string): Promise<{ dbPath: string; key: string; qq: string }> {
  const account = listAccounts().find((a) => a.id === accountId)
  if (!account) throw errors.notFound('账号', accountId)

  const qq = account.platformAccountId
  const { getQqKey } = await import('../qq')
  const key = getQqKey(qq)
  if (!key) {
    throw errors.notReady(
      `QQ ${qq} 还没有可用的数据库密钥`,
      '请到「添加账号」里粘贴 16 位密钥，或点「从 QQFlow 导入」复用已提取的密钥'
    )
  }
  const dbPath = account.dbStorageDir ?? ''
  if (!dbPath) {
    throw errors.notReady(`QQ ${qq} 没有登记数据库路径`, '请在「添加账号」里重新选择 nt_msg.db')
  }
  return { dbPath, key, qq }
}

/* ------------------------------------------------------------------ */
/* 会话列表刷新                                                        */
/* ------------------------------------------------------------------ */

/** 拉取某账号的联系人与群聊列表并落库 */
export async function refreshConversations(accountId: string): Promise<Conversation[]> {
  const account = listAccounts().find((a) => a.id === accountId)
  if (!account) throw errors.notFound('账号', accountId)

  let rows: Conversation[] = []

  if (backend === 'mock' || getSettings().mockMode) {
    rows = MOCK_CONTACTS.map((raw) => normalizeConversation(account.id, account.platform, raw))
  } else if (account.platform === 'qq') {
    // QQ：直接读本机 nt_msg.db（更新需求 §2.3）。
    // 会话 id 用 QQ 号 / 群号，与微信那条链路完全同构，所以下游不用感知平台差异。
    const { listQqConversations } = await import('../qq')
    const { dbPath, key } = await resolveQqSource(accountId)
    rows = await listQqConversations(account.id, dbPath, key)
  } else {
    const health = await ensureService({
      dbDir: getSettings().dbStorageDir || undefined
    })
    const contacts = await getContactsSafe(health.port)
    rows = contacts.map((raw) => normalizeConversation(account.id, account.platform, raw))
  }

  upsertConversations(rows)
  // 清理上游已不存在的会话（好友删除/退群）
  removeConversationsNotIn(
    accountId,
    rows.map((r) => r.id)
  )
  persistSoon()
  log.info('会话列表已刷新', { 账号: account.displayName, 平台: account.platform, 数量: rows.length })
  return listConversations({ accountId })
}

/** 兼容处理：上游 /api/contacts 不可用时回退到 address-book */
async function getContactsSafe(port: number): Promise<import('../wechat/types').RawContact[]> {
  // 动态 import，避免与 wechat 模块形成强耦合的顶层依赖
  const client = await import('../wechat/client')
  try {
    if (typeof client.getContacts === 'function') {
      return await client.getContacts(port)
    }
  } catch (e) {
    log.warn('/api/contacts 调用失败，尝试 address-book 回退', { error: String(e) })
  }
  if (typeof client.getAddressBook === 'function') {
    const rows = await client.getAddressBook(port, { perPage: 500 })
    return rows as unknown as import('../wechat/types').RawContact[]
  }
  throw errors.external('无法从 wechat_exp 获取联系人列表')
}

/* ------------------------------------------------------------------ */
/* 消息读取                                                            */
/* ------------------------------------------------------------------ */

/** 读取单个会话的新消息并落库，返回新增条数 */
async function syncConversation(conversation: Conversation, settings: ReturnType<typeof getSettings>): Promise<number> {
  let messages: ChatMessage[] = []

  if (backend === 'mock' || settings.mockMode) {
    const raws = mockMessages(conversation.platformConversationId)
    messages = raws.map((raw) => normalizeMessage(conversation, raw))
  } else if (conversation.platform === 'qq') {
    // QQ：读本机数据库并按 QQFlow 的算法解析消息 BLOB（更新需求 §2.3）
    const { listQqMessages } = await import('../qq')
    const { dbPath, key } = await resolveQqSource(conversation.accountId)
    messages = await listQqMessages(conversation.accountId, dbPath, key, conversation.id, {
      limit: 2000
    })
  } else {
    const health = await ensureService({ dbDir: settings.dbStorageDir || undefined })
    const lookbackFrom =
      settings.sync.lookbackDays > 0
        ? Date.now() - settings.sync.lookbackDays * 24 * 3600 * 1000
        : undefined
    // 只取最近一段：上游 wechat_exp 已有增量能力，这里用时间下界控制传输量。
    // maxPages 必须 ≤ KEEP_PER_CONVERSATION/200，否则会与保留策略互相打架（见顶部注释）。
    const raws = await getAllMessages(health.port, {
      chatId: conversation.platformConversationId,
      startDate: lookbackFrom ? toDateString(lookbackFrom) : undefined,
      maxPages: MAX_FETCH_PAGES
    })
    messages = raws.map((raw) => normalizeMessage(conversation, raw))
  }

  // 文件与链接的内容读取（更新需求 §2.1）：只对带附件的消息做，失败不影响主流程
  messages = await enrichMessages(messages)

  const inserted = insertMessages(messages)
  const total = countMessages(conversation.id)
  updateCachedCount(conversation.id, total)
  return inserted
}

/**
 * 给带文件/链接的消息补上「抓取到的正文」（更新需求 §2.1）。
 *
 * 放在这里而不是 normalize 阶段，原因：
 *   读取文件/抓网页是**慢操作**，而且只在消息真正落库前做一次即可；
 *   独立成一步也便于失败时整批降级（抓不到就只保留引用，不生成任务）。
 */
async function enrichMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const candidates = messages.filter((m) => m.kind === 'file' || m.kind === 'link')
  if (candidates.length === 0) return messages

  // 跳过「已经抓过附件正文」的消息。
  // 为什么必须跳过：同步每轮都会重新拉到同一批历史消息，若不跳过，就会反复读
  // 同一个本地文件、抓同一个网页——实测每轮上千次请求，单轮耗时 40 秒，
  // 比 30 秒的同步间隔还长，永远追不上。
  const { idsWithAttachments } = await import('../data/message-repo')
  const alreadyDone = idsWithAttachments(candidates.map((m) => m.id))
  const targets = candidates.filter((m) => !alreadyDone.has(m.id))
  if (targets.length === 0) return messages

  const { collectAttachments } = await import('../tasks/enrich')
  const out = [...messages]
  // 用 Map 建索引，避免对每条消息都 findIndex（O(n²)，消息多时很明显）
  const indexOf = new Map<string, number>()
  out.forEach((m, i) => indexOf.set(m.id, i))

  // 并发上限：这些操作会读磁盘 / 发网络请求，串行太慢、全并发会打爆句柄
  const CONCURRENCY = 4
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map((m) => collectAttachments(m).catch(() => undefined))
    )
    results.forEach((atts, k) => {
      if (!atts || atts.length === 0) return
      const idx = indexOf.get(batch[k].id)
      if (idx !== undefined) out[idx] = { ...out[idx], attachments: atts }
    })
  }
  log.debug('附件读取完成', {
    带附件消息: candidates.length,
    跳过已抓过: candidates.length - targets.length,
    本次抓取: targets.length
  })
  return out
}

function toDateString(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/* ------------------------------------------------------------------ */
/* 同步主流程                                                          */
/* ------------------------------------------------------------------ */

/** 执行一轮完整的同步：会话列表 → 消息 → 任务抽取 → 状态重分类 */
export async function runOnce(opts: { force?: boolean } = {}): Promise<SyncProgress> {
  if (roundInFlight) {
    log.warn('上一轮同步尚未结束，本次跳过')
    return getSyncStatus()
  }
  roundInFlight = true
  const started = Date.now()

  try {
    const settings = getSettings()

    // 0) 若未探测过后端，先探一次
    if (backend === 'none') await probe()

    if (backend === 'none' && !settings.mockMode) {
      setProgress({
        state: 'error',
        message: '未找到可用数据源：请安装 wechat_exp.exe，或在设置中开启「模拟数据模式」'
      })
      return getSyncStatus()
    }

    // 1) 确保数据后端就绪
    setProgress({ state: 'scanning', message: '扫描账号与数据目录…', progress: 0.05 })
    if (backend === 'mock' || settings.mockMode) {
      await ensureMockAccount()
      // 模拟模式下周期性注入一条新消息，让「实时更新」在界面上可见
      await maybeInjectMockLiveMessage()
    } else {
      const health = await ensureService({ dbDir: settings.dbStorageDir || undefined })
      log.info('wechat_exp 服务就绪', { port: health.port })
    }

    // 2) 刷新所有账号的会话列表
    const accounts = listAccounts()
    if (accounts.length === 0) {
      setProgress({
        state: 'idle',
        message: '尚未添加任何账号，请先在「账户管理」中添加',
        progress: 1
      })
      return getSyncStatus()
    }

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]
      setProgress({
        state: 'scanning',
        message: `刷新会话列表：${acc.displayName}`,
        progress: 0.1 + (0.15 * i) / accounts.length
      })
      try {
        await refreshConversations(acc.id)
      } catch (e) {
        log.error('刷新会话列表失败', {
          账号: acc.displayName,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }

    // 3) 读取已勾选会话的消息
    const selected = listSelected()
    if (selected.length === 0) {
      setProgress({
        state: 'idle',
        message: '尚未勾选任何联系人或群聊，请先到「联系人选择」里勾选',
        progress: 1
      })
      return getSyncStatus()
    }

    let totalInserted = 0
    for (let i = 0; i < selected.length; i++) {
      const conv = selected[i]
      setProgress({
        state: 'reading',
        message: `读取聊天记录：${conv.name}`,
        currentConversation: conv.name,
        progress: 0.3 + (0.5 * i) / selected.length
      })
      try {
        totalInserted += await syncConversation(conv, settings)
      } catch (e) {
        log.error('读取会话失败', {
          会话: conv.name,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }

    persistSoon()
    log.info('消息读取完成', {
      会话数: selected.length,
      新增消息: totalInserted,
      耗时ms: Date.now() - started
    })

    // 4) 任务抽取（需求：每获取一批新消息就对比合并）
    let report: Awaited<ReturnType<typeof extractTasks>> | null = null
    if (totalInserted > 0 || opts.force) {
      setProgress({ state: 'reading', message: '调用大模型抽取任务…', progress: 0.85 })
      try {
        report = await extractTasks({})
      } catch (e) {
        log.error('任务抽取失败', { error: e instanceof Error ? e.message : String(e) })
      }
    }

    // 5) 状态自动重分类（需求：运行过程中实时检测并重新标记）
    const reclassified = reclassifyAll().changed

    // 6) 体积控制（保留窗口必须 ≥ 拉取窗口，见文件顶部的不变式说明）
    pruneMessages(KEEP_PER_CONVERSATION)

    kvSet(KV.lastSyncAt, Date.now())
    persistSoon()

    setProgress({
      state: 'idle',
      message:
        `同步完成：新增 ${totalInserted} 条消息` +
        (report ? `，新建任务 ${report.tasksCreated} 个、合并 ${report.tasksMerged} 个` : '') +
        (reclassified > 0 ? `，状态更新 ${reclassified} 个` : ''),
      messagesRead: progress.messagesRead + totalInserted,
      progress: 1,
      currentConversation: undefined
    })

    log.info('一轮同步结束', {
      总耗时ms: Date.now() - started,
      新增消息: totalInserted,
      新建任务: report?.tasksCreated ?? 0,
      合并任务: report?.tasksMerged ?? 0,
      状态变更: reclassified
    })

    return getSyncStatus()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.error('同步失败', { error: message })
    setProgress({ state: 'error', message: `同步失败：${message}` })
    return getSyncStatus()
  } finally {
    roundInFlight = false
  }
}

/** 模拟数据模式下确保存在一个演示账号 */
async function ensureMockAccount(): Promise<void> {
  const existing = listAccounts()
  if (existing.length > 0) return
  const now = Date.now()
  const { insertAccount } = await import('../data/account-repo')
  insertAccount({
    id: 'mock-account-wechat',
    platform: 'wechat',
    platformAccountId: 'mock_wxid_demo',
    displayName: '演示账号（模拟数据）',
    state: 'online',
    loginMethod: 'local-detect',
    detectedLocally: true,
    createdAt: now,
    lastSeenAt: now,
    note: '模拟数据模式自动创建'
  })
  log.info('已创建演示账号（模拟数据模式）')
}

/* ------------------------------------------------------------------ */
/* 定时轮询                                                            */
/* ------------------------------------------------------------------ */

/** 启动定时同步（需求：定时轮询，默认每 30 秒） */
export async function startLoop(opts: { force?: boolean } = {}): Promise<SyncProgress> {
  const settings = getSettings()
  if (running && !opts.force) {
    log.info('同步循环已在运行')
    return getSyncStatus()
  }

  await probe()
  running = true
  setProgress({ state: 'scanning', message: '开始同步…' })

  // 立即跑一轮，让用户马上看到结果
  void runOnce(opts)

  const interval = Math.max(5000, settings.sync.intervalMs)
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    if (!running) return
    void runOnce()
  }, interval)

  log.info('同步循环已启动', { 间隔ms: interval, 后端: backend })
  return getSyncStatus()
}

/** 停止定时同步 */
export function stopLoop(): SyncProgress {
  running = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  log.info('同步循环已停止')
  return setProgress({ state: 'stopped', message: '已停止实时同步' })
}

export function isLoopRunning(): boolean {
  return running
}

/** 应用退出时释放资源（关闭 wechat_exp 子进程） */
export async function disposeSync(): Promise<void> {
  stopLoop()
  await stopService().catch((e) => {
    log.warn('关闭 wechat_exp 服务失败', { error: String(e) })
  })
}

/** 每轮同步「顺带」注入一条新消息，用于直观演示实时更新效果（仅模拟模式） */
export async function maybeInjectMockLiveMessage(): Promise<void> {
  if (backend !== 'mock' && !getSettings().mockMode) return
  mockRound++
  if (mockRound % 3 !== 0) return
  const selected = listSelected()
  if (selected.length === 0) return
  const conv = selected[mockRound % selected.length]
  const { appendLiveMockMessage } = await import('../wechat/mock')
  const chatId = conv.platformConversationId
  if (typeof appendLiveMockMessage === 'function') {
    appendLiveMockMessage(chatId)
    log.debug('已注入一条模拟新消息用于演示实时更新', { 会话: conv.name })
  }
}

export { makeConversationId }
