/**
 * 任务抽取调度器
 * ------------------------------------------------------------------
 * 把「聊天记录」变成「任务」的全过程：
 *   取消息 → 拼提示词 → 调 LLM → 解析 JSON → 回查发布人 → 查重 → 合并/新建 → 落库
 *
 * 两个重要机制：
 *   1. **游标（cursor）**：每个会话记录上次处理到的时间，下次只处理新增消息，
 *      并在边界处多带几条做上下文重叠，避免任务跨消息被截断。
 *   2. **实时去重**：每抽出一个任务就立刻与库中已有任务比对（需求原文
 *      「每获取一个都与先前获取到的信息进行实时对比」），命中则合并发布人。
 */
import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  Conversation,
  ExtractionReport,
  LlmProviderId,
  Task,
  TaskDraft,
  TaskPublisher
} from '@shared/types'
import { formatDateTime, parseUtc8 } from '@shared/time'
import { errors } from '../core/errors'
import { scoped } from '../core/logger'
import { getSettings } from '../core/settings'
import { execute, persistSoon, queryOne } from '../core/store'
import { getConversation, listConversations } from '../data/conversation-repo'
import { listMessages, listRecentMessages } from '../data/message-repo'
import { getPlainKey, getKeyRecord } from '../data/llm-repo'
import {
  insertTask,
  listTasksForDedup,
  replaceTask,
  getTask,
  hardDeleteTask,
  countByStatus
} from '../data/task-repo'
import { kvGet, kvSet, KV } from '../data/kv-repo'
import { chat, PROVIDERS } from '../llm'
import {
  buildTranscript,
  buildUserPrompt,
  parseTasks,
  resolvePublisher,
  toTaskDraft,
  buildOriginalSnippet,
  SYSTEM_PROMPT
} from './prompt'
import { heuristicExtract } from './heuristic'
import {
  createTaskFromDraft,
  featuresOf,
  findDuplicate,
  fingerprintOf,
  mergeIntoTask,
  mergeMaterials,
  mergePublishers,
  sameIdentity,
  type IdentityKey,
  type MatchCandidate,
  type TaskFeatures
} from './dedup'
import { classifyStatus } from './status'

const log = scoped('extractor')

/** 单次送入模型的最大消息条数（与 prompt 的字符上限配合，双重保险） */
const MAX_MESSAGES_PER_CALL = 400
/** 游标回退的消息条数：给模型足够的上下文（任务常是"先背景、后要求"） */
const CURSOR_OVERLAP = 30

/**
 * 「任务信号词」。仅用于**诊断日志**：当一段记录里出现了这些词、
 * 模型却一条任务都没抽出来时，说明大概率是漏抽，值得提示排查
 * （对照日志里的 transcript 预览即可判断是"没送进去"还是"模型没识别"）。
 */
const TASK_HINT_WORDS = [
  '任务',
  '报名',
  '接龙',
  '截止',
  '提交',
  '填写',
  '填报',
  '上交',
  '材料',
  '缴费',
  '签到',
  '会议',
  '面试',
  '讲座',
  '培训',
  '统计',
  '收集',
  '汇总',
  '通知'
]

export interface ExtractParams {
  /** 只处理指定会话；不传则处理所有已勾选的会话 */
  conversationIds?: string[]
  /** 忽略游标，重新处理最近的全部消息 */
  full?: boolean
  /** 强制使用规则抽取（不调 LLM）；不传则按配置自动决定 */
  useHeuristic?: boolean
  onProgress?: (info: {
    index: number
    total: number
    conversationName: string
    stage: string
  }) => void
}

/** 抽取时使用的引擎 */
interface Engine {
  kind: 'llm' | 'heuristic'
  provider?: LlmProviderId
  apiKey?: string
  model?: string
}

/** 决定用哪个引擎：有可用 Key 就用 LLM，否则退回规则抽取 */
function resolveEngine(forceHeuristic?: boolean): Engine {
  if (forceHeuristic) return { kind: 'heuristic' }

  const settings = getSettings()
  const provider = settings.activeLlm
  if (!provider) {
    log.warn('未选择 LLM 平台，本次使用规则抽取兜底')
    return { kind: 'heuristic' }
  }
  const apiKey = getPlainKey(provider)
  if (!apiKey) {
    log.warn('所选平台尚未配置 API Key，本次使用规则抽取兜底', { provider })
    return { kind: 'heuristic' }
  }
  const record = getKeyRecord(provider)
  const model = record?.model || PROVIDERS[provider]?.defaultModel
  if (!model) {
    log.warn('未找到该平台的可用模型，改用规则抽取', { provider })
    return { kind: 'heuristic' }
  }
  return { kind: 'llm', provider, apiKey, model }
}

/**
 * 读取某会话在本轮要处理的消息（游标增量 + 上下文重叠）。
 *
 * 返回 **null** 表示「没有新消息」——上层应直接跳过该会话。
 * 这个返回值的意义很大：早期版本在"没有新消息"时也会把游标前那几条
 * 重新拼一批送去模型，于是每轮同步都会对**同一个会话反复调用大模型**，
 * 抽出来的还是同一批任务、反复走一遍"合并"逻辑——既烧 token，
 * 也让日志里全是"新建 0 / 合并 N"，真正的漏抽反而看不出来。
 *
 * 上下文重叠 CURSOR_OVERLAP 从 5 提到 30：任务常常是「先讲背景、再说要求」，
 * 只回退 5 条时模型看不到前因后果，就容易把带"任务"字样的消息判成闲聊。
 */
function pickMessages(conversation: Conversation, full: boolean): ChatMessage[] | null {
  if (full) {
    return listRecentMessages(conversation.id, MAX_MESSAGES_PER_CALL)
  }
  const cursor = kvGet<number>(KV.convCursor(conversation.id), 0)
  if (!cursor) {
    // 首次处理该会话：把最近一批整体作为基线
    return listRecentMessages(conversation.id, MAX_MESSAGES_PER_CALL)
  }

  // 游标之后的消息（listMessages 的 from 是「>=」，故含游标那条）
  const fresh = listMessages({
    conversationId: conversation.id,
    from: cursor,
    limit: MAX_MESSAGES_PER_CALL
  })
  // 只有游标那条本身、没有任何**更新**的消息 → 本轮无事可做
  const hasNew = fresh.some((m) => m.timestamp > cursor)
  if (!hasNew && fresh.length < MAX_MESSAGES_PER_CALL) return null

  // 需要再补几条游标之前的内容做上下文
  const before = listMessages({
    conversationId: conversation.id,
    to: cursor - 1,
    limit: CURSOR_OVERLAP
  })
  return [...before, ...fresh]
}

/** 本轮抽取的统计 */
interface ApplyResult {
  created: number
  merged: number
}

/**
 * 把一批草稿落库：逐条与已有任务比对，命中则合并，否则新建。
 *
 * 候选集在**内存里增量维护**：新建或合并后立刻更新对应条目，
 * 这样同一批次内先后抽出的同一任务也能互相匹配上（需求要求「实时对比」）。
 *
 * ⚠️ 两处直接对应更新需求 §5 的修复，改动时务必保留：
 *   1. 候选集来自 listTasksForDedup()，**覆盖全部 5 个分类（含已删除）**。
 *      之前只取未删除的，于是"已完成"的任务在下一轮同步时匹配不到，
 *      又被当成新任务插了一条——正是用户报的那个 bug。
 *   2. 命中后一律合并到**已存在的那条**，绝不新建；合并时保留原状态，
 *      所以已完成的不会被改回进行中。
 */
function applyDrafts(
  drafts: { draft: TaskDraft; publisher: TaskPublisher; messageIds: string[] }[],
  llm: Task['llm'] | undefined
): ApplyResult {
  let created = 0
  let merged = 0

  // 一次性取出全部候选（含已删除分类），后续在内存里增量维护，避免每次重查数据库
  const candidates: MatchCandidate[] = listTasksForDedup().map((row) => ({
    id: row.id,
    fingerprint: row.fingerprint,
    features: featuresOf(row.features),
    publisherNames: (row.features.publishers ?? []).map((p) => p.name),
    status: row.status,
    createdAt: row.createdAt
  }))

  for (const item of drafts) {
    const features = featuresOf(item.draft)
    const fingerprint = fingerprintOf({ name: item.draft.name, endAt: item.draft.endAt })

    const hit = findDuplicate(
      { ...features, publisherNames: [item.publisher.name] },
      fingerprint,
      candidates
    )

    if (hit) {
      const existing = getTask(hit.candidate.id)
      if (existing) {
        const mergedTask = mergeIntoTask(existing, item.draft, item.publisher, item.messageIds)
        mergedTask.llm = existing.llm ?? llm
        // mergeIntoTask 已经保留了 existing.status / statusLocked，
        // 这里再显式断言一次，避免日后有人改 merge 时不小心把"已完成"打回"进行中"。
        mergedTask.status = existing.status
        mergedTask.statusLocked = existing.statusLocked
        replaceTask(mergedTask)

        // 更新内存候选，让后续草稿能匹配到合并后的结果
        const idx = candidates.findIndex((c) => c.id === mergedTask.id)
        const next: MatchCandidate = {
          id: mergedTask.id,
          fingerprint: mergedTask.fingerprint,
          features: featuresOf(mergedTask),
          publisherNames: mergedTask.publishers.map((p) => p.name),
          status: mergedTask.status,
          createdAt: mergedTask.createdAt
        }
        if (idx >= 0) candidates[idx] = next
        else candidates.push(next)

        merged++
        log.info('任务合并（判定为同一任务）', {
          任务: existing.name,
          判定依据: hit.reason,
          相似度: Number(hit.score.toFixed(3)),
          原分类: existing.status,
          新增发布人: item.publisher.name,
          群聊: item.publisher.conversationName
        })
        continue
      }
    }

    // 新建：状态按当前时间初始化
    const now = Date.now()
    const status = classifyStatus(
      { startAt: item.draft.startAt, endAt: item.draft.endAt, status: 'ongoing', statusLocked: false },
      now
    )
    const orderRow = queryOne<{ n: number }>('SELECT COALESCE(MAX(tile_order), 0) + 1 AS n FROM tasks')
    const task = createTaskFromDraft({
      id: randomUUID(),
      draft: item.draft,
      publisher: item.publisher,
      sourceMessageIds: item.messageIds,
      status,
      tileOrder: orderRow?.n ?? 1,
      llm
    })
    insertTask(task)
    candidates.push({
      id: task.id,
      fingerprint: task.fingerprint,
      features: featuresOf(task),
      publisherNames: task.publishers.map((p) => p.name),
      status: task.status,
      createdAt: task.createdAt
    })
    created++
    log.info('新任务', {
      名称: task.name,
      类型: task.type,
      状态: task.status,
      发布人: item.publisher.name,
      群聊: item.publisher.conversationName,
      置信度: task.confidence
    })
  }

  // 收尾：同一任务如果因为历史原因散落在多个分类里，只保留**最早创建**的那条，
  // 其余把发布人并过去后删掉（更新需求 §5 边界要求）。
  dedupeAcrossCategories()

  return { created, merged }
}

/**
 * 跨分类去重：同一任务在多个分类里各有一条时，保留最早创建的那条，
 * 把其余条目的发布人合并过去，然后**彻底删除**多余的那几条。
 *
 * 为什么会发生：早期版本的去重只看未删除的任务，同一件事可能在"进行中"
 * 和"已完成"里各留下一条。这里做一次自愈，用户不用手动清。
 */
function dedupeAcrossCategories(): number {
  const rows = listTasksForDedup() // 已按 created_at 升序，第一条即最早的
  const kept: MatchCandidate[] = []
  let removed = 0

  for (const row of rows) {
    const features = featuresOf(row.features)
    const key: IdentityKey & TaskFeatures = {
      ...features,
      publisherNames: (row.features.publishers ?? []).map((p) => p.name)
    }

    // 只在「三元组一致」这种确定性条件下合并，避免误删真正不同的任务
    const dup = kept.find((k) =>
      sameIdentity(key, {
        name: k.features.name,
        startAt: k.features.startAt,
        publisherNames: k.publisherNames
      })
    )

    if (!dup) {
      kept.push({
        id: row.id,
        fingerprint: row.fingerprint,
        features,
        publisherNames: key.publisherNames,
        status: row.status,
        createdAt: row.createdAt
      })
      continue
    }

    // 把这条的发布人并进保留的那条
    const survivor = getTask(dup.id)
    const loser = getTask(row.id)
    if (survivor && loser) {
      const mergedPublishers = mergePublishers(survivor.publishers, loser.publishers)
      const mergedSources = Array.from(
        new Set([...survivor.sourceMessageIds, ...loser.sourceMessageIds])
      )
      replaceTask({
        ...survivor,
        publishers: mergedPublishers,
        sourceMessageIds: mergedSources,
        materials: mergeMaterials(survivor.materials, loser.materials),
        updatedAt: Date.now()
      })
      hardDeleteTask(loser.id)
      dup.publisherNames = mergedPublishers.map((p) => p.name)
      removed++
      log.warn('发现同一任务散落在多个分类，已合并到最早创建的那条', {
        保留: survivor.name,
        保留分类: survivor.status,
        删除: `${loser.name}（${loser.status}）`
      })
    }
  }

  return removed
}

/** 用 LLM 处理一个会话，返回草稿列表 */
async function extractWithLlm(
  conversation: Conversation,
  messages: ChatMessage[],
  engine: Engine
): Promise<{ draft: TaskDraft; publisher: TaskPublisher; messageIds: string[] }[]> {
  const { text, usedMessages, truncated } = buildTranscript(messages)

  // 诊断日志：把「实际送给模型的内容」记下来。
  // 排查「某条消息为什么没被抽出来」时先看这里——多数情况是消息根本没进 transcript
  // （未勾选该会话 / 游标已越过 / 被字符上限截断），而不是模型不识别。
  log.debug('送入模型的 transcript', {
    会话: conversation.name,
    原始消息数: messages.length,
    实际使用: usedMessages.length,
    字符数: text.length,
    截断: truncated,
    预览: text.slice(0, 800)
  })

  if (usedMessages.length < 2) {
    log.warn('送入模型的消息不足 2 条，跳过该会话（这批消息本轮不会被抽取）', {
      会话: conversation.name,
      原始消息数: messages.length,
      可用消息数: usedMessages.length
    })
    return []
  }

  if (truncated) {
    log.warn('会话消息过长，只送入了最近的部分（更早的消息本轮被跳过）', {
      会话: conversation.name,
      实际条数: usedMessages.length
    })
  }

  const response = await chat({
    provider: engine.provider!,
    apiKey: engine.apiKey!,
    model: engine.model!,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(conversation, text) }],
    temperature: 0.1, // 抽取任务要稳定，温度压到最低
    maxTokens: 4096,
    jsonMode: true
  })

  const parsed = parseTasks(response.text)
  log.debug('模型返回', {
    会话: conversation.name,
    任务数: parsed.length,
    耗时ms: response.latencyMs,
    模型: response.model,
    原文: response.text.slice(0, 800)
  })

  // 一条都没抽出来、但内容里明显有任务信号词 → 大概率是漏抽，留一条 WARN 供排查
  if (parsed.length === 0) {
    const hits = TASK_HINT_WORDS.filter((w) => text.includes(w))
    if (hits.length > 0) {
      log.warn('模型未抽出任务，但记录里出现了任务关键词（疑似漏抽，可对照下方片段排查）', {
        会话: conversation.name,
        命中关键词: hits.join('、'),
        transcript字符数: text.length,
        消息条数: usedMessages.length,
        片段: text.slice(-600)
      })
    }
  }

  const out: { draft: TaskDraft; publisher: TaskPublisher; messageIds: string[] }[] = []
  for (const p of parsed) {
    const publisher = resolvePublisher(
      p,
      usedMessages,
      conversation,
      conversation.accountId,
      conversation.platform,
      (t) => parseUtc8(t)
    )
    const draft = toTaskDraft(p, publisher, usedMessages, (t, eod) => parseUtc8(t, eod))
    // 只把「发布人那条消息起、附近一段」作为来源，避免把整段对话记成来源
    const messageIds = usedMessages
      .filter((m) => Math.abs(m.timestamp - publisher.publishedAt) <= 20 * 60_000)
      .map((m) => m.id)
    out.push({ draft, publisher, messageIds: messageIds.length ? messageIds : [publisher.messageId ?? ''] })
  }
  return out
}

/** 用规则处理一个会话 */
function extractWithHeuristic(
  conversation: Conversation,
  messages: ChatMessage[]
): { draft: TaskDraft; publisher: TaskPublisher; messageIds: string[] }[] {
  const hits = heuristicExtract(messages)
  return hits.map(({ draft, message }) => {
    const publisher: TaskPublisher = {
      name: message.senderName || (message.isSelf ? '我' : '未知'),
      accountId: conversation.accountId,
      platform: conversation.platform,
      conversationId: conversation.id,
      conversationName: conversation.name,
      isSelf: message.isSelf,
      publishedAt: message.timestamp,
      messageId: message.id
    }
    // 规则抽取没法给出准确的原文片段，这里用同发送者附近的几条补上下文
    const nearby = messages.filter((m) => Math.abs(m.timestamp - message.timestamp) <= 5 * 60_000)
    const snippet = buildOriginalSnippet(publisher, nearby.length ? nearby : [message], {
      maxMessages: 8
    })
    return {
      draft: { ...draft, originalText: snippet },
      publisher,
      messageIds: nearby.map((m) => m.id)
    }
  })
}

/**
 * 主入口：执行一次任务抽取。
 * 会被「同步服务」在每轮读取后调用，也可以由界面手动触发。
 */
export async function extractTasks(params: ExtractParams = {}): Promise<ExtractionReport> {
  const startedAt = Date.now()
  const batchId = randomUUID()

  // 1) 决定处理哪些会话
  const conversations = params.conversationIds?.length
    ? params.conversationIds
        .map((id) => getConversation(id))
        .filter((c): c is Conversation => c !== null)
    : listConversations({ onlySelected: true })

  if (conversations.length === 0) {
    log.warn('没有需要处理的会话（可能尚未勾选任何联系人或群聊）')
    return {
      batchId,
      startedAt,
      finishedAt: Date.now(),
      conversationsProcessed: 0,
      messagesSent: 0,
      tasksCreated: 0,
      tasksMerged: 0,
      failures: []
    }
  }

  const engine = resolveEngine(params.useHeuristic)
  log.info('开始任务抽取', {
    引擎: engine.kind === 'llm' ? `${engine.provider}/${engine.model}` : '规则兜底',
    会话数: conversations.length,
    全量模式: Boolean(params.full)
  })

  let messagesSent = 0
  let tasksCreated = 0
  let tasksMerged = 0
  const failures: { conversationId: string; error: string }[] = []

  // 2) 逐个会话处理（顺序执行：LLM 有并发/限流限制，顺序最稳）
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]
    params.onProgress?.({
      index: i + 1,
      total: conversations.length,
      conversationName: conv.name,
      stage: '读取消息'
    })

    try {
      const messages = pickMessages(conv, Boolean(params.full))
      if (messages === null) {
        // 没有新消息：本轮直接跳过，不调用大模型
        // （否则每轮都会把同一批旧消息重发一遍，白烧 token 且反复"合并"）
        log.debug('会话没有新消息，本轮跳过', { 会话: conv.name })
        continue
      }
      if (messages.length < 2) {
        log.debug('会话消息过少，跳过', { 会话: conv.name, 条数: messages.length })
        continue
      }
      messagesSent += messages.length

      params.onProgress?.({
        index: i + 1,
        total: conversations.length,
        conversationName: conv.name,
        stage: engine.kind === 'llm' ? '调用大模型' : '规则抽取'
      })

      const drafts =
        engine.kind === 'llm'
          ? await extractWithLlm(conv, messages, engine)
          : extractWithHeuristic(conv, messages)

      if (drafts.length > 0) {
        params.onProgress?.({
          index: i + 1,
          total: conversations.length,
          conversationName: conv.name,
          stage: `落库 ${drafts.length} 条`
        })
        const llmMeta: Task['llm'] | undefined =
          engine.kind === 'llm'
            ? {
                provider: engine.provider!,
                model: engine.model!,
                extractedAt: Date.now(),
                batchId
              }
            : undefined
        const res = applyDrafts(drafts, llmMeta)
        tasksCreated += res.created
        tasksMerged += res.merged
      }

      // 3) 更新游标到本批最后一条消息（无论是否抽出任务）
      const lastTs = messages[messages.length - 1].timestamp
      kvSet(KV.convCursor(conv.id), lastTs)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      failures.push({ conversationId: conv.id, error: message })
      log.error('会话抽取失败', { 会话: conv.name, 错误: message })
      // 单个会话失败不影响其它会话，继续处理
    }
  }

  const finishedAt = Date.now()
  execute(
    `INSERT INTO extraction_runs (id, started_at, finished_at, conversations, messages, created, merged, failures)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      batchId,
      startedAt,
      finishedAt,
      conversations.length,
      messagesSent,
      tasksCreated,
      tasksMerged,
      failures.length ? JSON.stringify(failures) : null
    ]
  )
  persistSoon()

  const report: ExtractionReport = {
    batchId,
    startedAt,
    finishedAt,
    conversationsProcessed: conversations.length - failures.length,
    messagesSent,
    tasksCreated,
    tasksMerged,
    failures
  }

  log.info('任务抽取完成', {
    耗时ms: finishedAt - startedAt,
    新建: tasksCreated,
    合并: tasksMerged,
    失败: failures.length,
    当前分类统计: countByStatus()
  })

  return report
}

/** 最近一次抽取批次摘要（界面展示「上次抽取时间/结果」） */
export function lastExtractionRun(): {
  id: string
  startedAt: number
  finishedAt: number | null
  created: number
  merged: number
  messages: number
  failures: number
} | null {
  const row = queryOne<{
    id: string
    started_at: number
    finished_at: number | null
    created: number
    merged: number
    messages: number
    failures: string | null
  }>('SELECT * FROM extraction_runs ORDER BY started_at DESC LIMIT 1')
  if (!row) return null
  let failureCount = 0
  if (row.failures) {
    try {
      failureCount = (JSON.parse(row.failures) as unknown[]).length
    } catch {
      failureCount = 0
    }
  }
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    created: row.created,
    merged: row.merged,
    messages: row.messages,
    failures: failureCount
  }
}

/** 供界面展示的「上次抽取」文案 */
export function lastExtractionText(): string {
  const run = lastExtractionRun()
  if (!run) return '尚未执行过任务抽取'
  return `${formatDateTime(run.startedAt)} · 新建 ${run.created} / 合并 ${run.merged}` +
    (run.failures > 0 ? ` · ${run.failures} 个会话失败` : '')
}

export { errors }
