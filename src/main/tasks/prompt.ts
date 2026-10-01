/**
 * LLM 任务抽取提示词与结果解析
 * ------------------------------------------------------------------
 * 对应需求「模块 6：LLM 任务提取」。
 *
 * 设计取舍：
 *   - 提示词要求模型**只输出 JSON**，并在代码里做严格校验与容错
 *     （模型输出不可靠，任何字段缺失都不能让流程崩掉）
 *   - 允许模型对没有明确名称/主题的任务**自行起名**（需求要求，风格参考 DeepSeek 网页
 *     给聊天起名的风格：简洁、具体、不带书名号与句号）
 *   - 明确要求「不确定就留空」，禁止编造——这是整个功能的可信度基础
 *   - 发布人不由模型「决定」，而是由模型指出**最早那条相关消息的时间戳**，
 *     再由代码回查真实消息，拿到可靠的发送者与时间
 */
import type { ChatMessage, Conversation, TaskDraft, TaskMaterial, TaskPublisher } from '@shared/types'
import { formatDateTime } from '@shared/time'
import { attachmentsToContext } from './enrich'

/** 单次送入模型的字符上限（超过则只保留最近的部分） */
export const MAX_TRANSCRIPT_CHARS = 12_000

/**
 * 附件正文最多占 transcript 总额度的比例。
 * 为什么设上限：文件/网页正文动辄上万字，若不限量会把聊天正文挤光，
 * 反而丢掉「谁在什么语境下发的要求」这类关键信息。40% 是留足聊天主干的折中。
 */
export const MAX_ATTACHMENT_RATIO = 0.4

/** 系统提示词：定义角色、输出格式与硬性规则 */
export const SYSTEM_PROMPT = `你是一个中文聊天记录信息抽取助手。用户会给你一段群聊或私聊的聊天记录，你要从中找出所有「任务/事项/通知」类信息，并输出结构化 JSON。

【什么算任务】
需要有人去做某件事的信息，典型包括：
- 报名参加活动/比赛/培训
- 提交材料、表格、文档、作业
- 填写共享表格、在线问卷、在线文档
- 参加会议、讲座、答辩、面试（有明确时间地点）
- 缴费、领取物品、办理手续
- 有明确截止时间的各类通知
【什么不算任务】
闲聊、问候、表情、纯提问没人回答的、广告推销、已明确取消的、纯粹的信息分享（如转发新闻）。

【输出格式】只输出一个 JSON 对象，不要输出任何解释文字，不要用 markdown 代码块包裹：
{
  "tasks": [
    {
      "name": "任务名称",
      "topic": "一句话说明这个任务要做什么（30 字以内）",
      "type": "任务类型",
      "organizers": ["负责方/主办单位名称"],
      "startAt": "YYYY-MM-DD HH:mm 或空字符串",
      "endAt": "YYYY-MM-DD HH:mm 或空字符串",
      "contactPerson": "接头人姓名，没有就空字符串",
      "publisherName": "最早发布这个任务的人的显示名（必须与聊天记录中的名字完全一致）",
      "firstPublishedAt": "那条消息的时间，格式必须是 YYYY-MM-DD HH:MM，必须与聊天记录中的时间完全一致",
      "materials": [
        {
          "name": "材料名称，如「报名表」「一寸照片」",
          "kind": "form | document | link | offline | unknown",
          "url": "线上链接（没有就空字符串）",
          "required": true,
          "note": "补充说明，如份数、格式要求"
        }
      ],
      "confidence": 0.85
    }
  ]
}
如果没有任何任务，输出 {"tasks": []}。

【字段规则】
1. name：聊天里如果写明了任务名称就用原文；没有就用一句简洁的话概括，风格像给聊天记录起标题——具体、点明主体和动作，不超过 20 字，不要用书名号、不要句号结尾。
2. type：从「表单填写」「材料提交」「报名」「会议」「缴费」「领取」「考试」「其他」里选一个最贴切的；也可以自拟更准确的四字词。
3. organizers：负责人或组织（如「学院办公室」「教务处」），没有就空数组。
4. startAt / endAt：能明确判断才填。只有日期没有时间时，startAt 填当天 00:00，endAt 填当天 23:59。
   禁止猜测——原文没写时间就留空字符串。
5. contactPerson：明确写的「联系人/找某某/加微信 xxx」才算，没有就空字符串。
6. materials：把所有需要提交/填写的东西都列出来。
   - kind 判断：共享表格/在线表单/问卷 → form；要交的文档、照片、纸质材料 → document；
     报名链接、网页 → link；线下领取/线下提交 → offline；无法判断 → unknown。
   - url 只有原文中真实出现的链接才填，**绝对不要自己编造链接**。
7. publisherName 与 firstPublishedAt：必须是聊天记录里**真实存在**的人名和时间（逐字照抄），
   指向**最早提到这个任务的那条消息**。这两个字段用于回查真实消息，填错会导致发布人信息错误。
8. confidence：你对自己抽取结果的把握，0~1 之间的小数。

【文件与链接附件】
聊天记录里以「└─ 附件《…》内容摘要:」「└─ 链接《…》内容摘要:」开头的行，是从该消息携带的
**文件或网页里实际读到的正文**，与聊天正文同等重要：
- 任务名称、主题、时间常常只写在文件或网页里，不在聊天正文中——判断有没有任务时必须结合附件内容。
- 附件里出现的时间（报名截止、会议时间等）、负责方、联系人、需要提交的材料，都照常抽取。
- 仍然遵守「不确定就留空、绝不编造」：附件摘要以「…」结尾表示被截断，不要脑补后面的内容；
  附件没有内容摘要就表示没读到正文，不要据此生造任务。
- 附件内容与聊天正文冲突时，以附件里更具体的说法为准（例如更精确的时间）。

【硬性要求】
- 不确定的字段一律留空（空字符串或空数组），**绝对不要编造**。
- 同一条消息里的同一件事只输出一个任务。
- 时间一律用 24 小时制，必须写成 YYYY-MM-DD HH:mm 的固定格式。
- 只输出 JSON，不要有任何前后缀文字。`

/**
 * 把消息列表拼成给模型看的对话文本。
 * 格式：`[2026-09-27 14:03] 张明: 内容`
 * 带附件的消息在其下面追加附件正文摘要（缩进两格，`└─` 引导）：
 *   `[2026-09-27 14:03] 张明: 大家看下这个通知`
 *   `  └─ 附件《报名表.docx》内容摘要: …`
 * 超长时保留**最近**的部分（任务通常在最近的消息里），并在开头注明省略。
 *
 * 附件正文的额度：最多占 maxChars 的 40%（见 MAX_ATTACHMENT_RATIO），
 * 避免大文件正文把聊天主干挤掉。
 */
export function buildTranscript(
  messages: ChatMessage[],
  opts: { maxChars?: number; includeSystem?: boolean } = {}
): { text: string; usedMessages: ChatMessage[]; truncated: boolean } {
  const maxChars = opts.maxChars ?? MAX_TRANSCRIPT_CHARS
  const includeSystem = opts.includeSystem ?? false

  // 过滤：系统消息默认不送（噪声大，且系统消息容易让模型误判）；
  // 正文为空的消息**不能一概丢掉**——纯文件/纯链接消息常常没有配文，
  // 但任务信息恰恰藏在文件正文里（见下方的附件摘要）。
  const usable = messages
    .filter((m) => (includeSystem ? true : m.kind !== 'system'))
    .filter((m) => {
      const hasText = (m.text ?? '').trim().length > 0
      const hasAttachmentText = (m.attachments ?? []).some(
        (a) => a.status === 'ok' && (a.text ?? '').trim().length > 0
      )
      return hasText || hasAttachmentText
    })
    .sort((a, b) => a.timestamp - b.timestamp)

  const attachBudget = Math.floor(maxChars * MAX_ATTACHMENT_RATIO)
  const lines: string[] = []
  let total = 0
  let attachUsed = 0
  const chosen: ChatMessage[] = []
  let truncated = false

  // 从最新往前累加，到达上限后停止 —— 保证保留最近的内容
  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i]
    const who = m.isSelf ? `${m.senderName || '我'}（本人）` : m.senderName || '未知'
    // 内容里的换行会破坏「一行一条」的结构，压成空格；
    // 正文为空（纯附件消息）时给个占位，避免出现「张三: 」这样的空行
    const body = m.text.replace(/\s*\n+\s*/g, ' ').trim() || '（无正文，内容见下方附件）'
    const line = `[${formatDateTime(m.timestamp)}] ${who}: ${body}`

    // 附件正文摘要：只取「已成功读到正文」的附件；受附件总额度限制
    let block = ''
    const withText = (m.attachments ?? []).filter((a) => a.status === 'ok' && (a.text ?? '').trim().length > 0)
    if (withText.length > 0) {
      const remain = attachBudget - attachUsed
      if (remain > 0) {
        let ctx = attachmentsToContext(withText)
        if (ctx.length > remain) ctx = `${ctx.slice(0, remain)}…`
        if (ctx) block = `\n${ctx}`
      }
    }

    const addLen = line.length + block.length + 1
    if (total + addLen > maxChars && chosen.length > 0) {
      truncated = true
      break
    }
    lines.push(line + block)
    chosen.push(m)
    total += addLen
    attachUsed += block.length
  }

  lines.reverse()
  chosen.reverse()

  const header = truncated ? `（较早的消息已省略，以下为最近 ${chosen.length} 条）\n` : ''
  return { text: header + lines.join('\n'), usedMessages: chosen, truncated }
}

/** 用户提示词：说明会话背景 + 聊天记录 */
export function buildUserPrompt(conversation: Conversation, transcript: string): string {
  const kindLabel = conversation.kind === 'group' ? '群聊' : '私聊'
  return `会话名称：${conversation.name}
会话类型：${kindLabel}
（会话内显示名为「本人」的消息，是当前用户自己发出的）

聊天记录如下：
${transcript}

请抽取其中的任务，按系统提示要求的 JSON 格式输出。`
}

/* ------------------------------------------------------------------ */
/* 结果解析                                                            */
/* ------------------------------------------------------------------ */

/** 模型返回的原始任务对象（字段全部按不可信处理） */
interface RawTask {
  name?: unknown
  topic?: unknown
  type?: unknown
  organizers?: unknown
  startAt?: unknown
  endAt?: unknown
  contactPerson?: unknown
  publisherName?: unknown
  firstPublishedAt?: unknown
  materials?: unknown
  confidence?: unknown
}

/** 从模型输出里剥出 JSON（兼容 markdown 代码块、前后多余文字） */
export function extractJsonPayload(text: string): unknown {
  const raw = (text ?? '').trim()
  if (!raw) throw new Error('模型返回内容为空')

  // 1) 直接解析
  try {
    return JSON.parse(raw)
  } catch {
    /* 继续尝试其它方式 */
  }

  // 2) 去掉 ```json ... ``` 包裹
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      /* 继续 */
    }
  }

  // 3) 截取第一个 { 到最后一个 } 之间的内容
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const slice = raw.slice(first, last + 1)
    try {
      return JSON.parse(slice)
    } catch (e) {
      throw new Error(`模型返回的 JSON 无法解析: ${String(e)}；原文片段: ${slice.slice(0, 300)}`)
    }
  }

  throw new Error(`模型返回内容中找不到 JSON 对象；原文片段: ${raw.slice(0, 300)}`)
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(asString).filter((s) => s.length > 0 && !/^(无|未知|none|null)$/i.test(s))
  }
  const single = asString(v)
  return single ? [single] : []
}

const MATERIAL_KINDS = ['form', 'document', 'link', 'offline', 'unknown'] as const

function parseMaterials(v: unknown): TaskMaterial[] {
  if (!Array.isArray(v)) return []
  const out: TaskMaterial[] = []
  for (const item of v) {
    if (typeof item === 'string') {
      const name = item.trim()
      if (name) out.push({ name, kind: 'unknown', required: true })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = asString(o.name) || asString(o.title) || asString(o.type)
    const url = asString(o.url) || asString(o.link)
    if (!name && !url) continue
    const kindRaw = asString(o.kind) as (typeof MATERIAL_KINDS)[number]
    const kind = MATERIAL_KINDS.includes(kindRaw) ? kindRaw : url ? 'link' : 'unknown'
    out.push({
      name: name || url,
      kind,
      url: url || undefined,
      required: o.required === undefined ? true : Boolean(o.required),
      note: asString(o.note) || undefined
    })
  }
  return out
}

/** 解析后的中间结构（时间仍是字符串，由调用方按 UTC+8 转换） */
export interface ParsedRawTask {
  name: string
  topic: string
  type: string
  organizers: string[]
  startAtText: string
  endAtText: string
  contactPerson: string
  publisherName: string
  firstPublishedAtText: string
  materials: TaskMaterial[]
  confidence?: number
}

/** 把模型输出解析为中间结构数组 */
export function parseTasks(text: string): ParsedRawTask[] {
  const payload = extractJsonPayload(text)

  // 兼容三种形态：{tasks:[...]}、[...]、单个 {...}
  let list: unknown[] = []
  if (Array.isArray(payload)) {
    list = payload
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (Array.isArray(obj.tasks)) list = obj.tasks
    else if (Array.isArray(obj.data)) list = obj.data
    else if (Array.isArray(obj.result)) list = obj.result
    else list = [obj] // 单个任务对象
  }

  const out: ParsedRawTask[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const t = item as RawTask

    const name = asString(t.name)
    const topic = asString(t.topic)
    // 名称与主题都空 → 大概率是模型输出的噪声对象，丢弃
    if (!name && !topic) continue

    const confRaw = typeof t.confidence === 'number' ? t.confidence : Number(asString(t.confidence))
    const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : undefined

    out.push({
      name,
      topic,
      type: asString(t.type),
      organizers: asStringArray(t.organizers).slice(0, 10),
      startAtText: asString(t.startAt),
      endAtText: asString(t.endAt),
      contactPerson: asString(t.contactPerson),
      publisherName: asString(t.publisherName),
      firstPublishedAtText: asString(t.firstPublishedAt),
      materials: parseMaterials(t.materials),
      confidence
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 发布人回查                                                          */
/* ------------------------------------------------------------------ */

/**
 * 根据模型给出的「最早消息时间 + 发布人名字」在真实消息里回查。
 * 为什么这么做：发布人信息是需求里的硬要求（「发布人为最早发布该任务的用户」），
 * 不能信任模型直接生成的字符串——必须落到真实消息上，才能拿到可靠的
 * 账号、会话、时间与是否本人。
 *
 * 回查顺序：
 *   ① 时间戳完全匹配（模型被要求逐字照抄，命中率最高）
 *   ② 同一条时间戳附近 ±2 分钟内、且发送者名字匹配
 *   ③ 该会话中该发送者的第一条消息
 *   ④ 兜底：会话中最早的那条消息
 */
export function resolvePublisher(
  parsed: ParsedRawTask,
  usedMessages: ChatMessage[],
  conversation: Conversation,
  accountId: string,
  platform: Conversation['platform'],
  /**
   * 把 `YYYY-MM-DD HH:MM` 解析回时间戳；由调用方注入（用 shared/time 的实现），
   * 避免这里再引一份时间逻辑。
   */
  parseTimestamp: (text: string) => number | undefined
): TaskPublisher {
  const fallback: TaskPublisher = {
    name: conversation.name || '未知',
    accountId,
    platform,
    conversationId: conversation.id,
    conversationName: conversation.name,
    isSelf: false,
    publishedAt: usedMessages[0]?.timestamp ?? Date.now()
  }

  const targetTs = parseTimestamp(parsed.firstPublishedAtText)
  const wantName = parsed.publisherName.replace(/\s+/g, '')

  /** 组装一条发布人记录 */
  const from = (m: ChatMessage): TaskPublisher => ({
    name: m.senderName || (m.isSelf ? '我' : '未知'),
    accountId,
    platform,
    conversationId: conversation.id,
    conversationName: conversation.name,
    isSelf: m.isSelf,
    publishedAt: m.timestamp,
    messageId: m.id
  })

  // ① 时间戳精确匹配（分钟粒度）
  if (targetTs !== undefined) {
    const exact = usedMessages.find((m) => Math.abs(m.timestamp - targetTs) < 60_000)
    if (exact) {
      // 若模型给的名字与消息发送者不一致，以真实消息为准（真实数据优先）
      return from(exact)
    }
  }

  // ② 名字匹配 + 时间接近（±2 分钟）
  if (wantName) {
    const near = usedMessages.find(
      (m) =>
        m.senderName.replace(/\s+/g, '') === wantName &&
        (targetTs === undefined || Math.abs(m.timestamp - targetTs) <= 2 * 60_000)
    )
    if (near) return from(near)

    // ③ 名字模糊匹配（模型可能漏掉后缀/空格）
    const fuzzy = usedMessages.find(
      (m) =>
        wantName.length >= 2 &&
        (m.senderName.includes(wantName) || wantName.includes(m.senderName.replace(/\s+/g, ''))) &&
        m.senderName.length > 0
    )
    if (fuzzy) return from(fuzzy)

    // ④ 该发送者的第一条消息
    const firstBySender = usedMessages.find((m) => m.senderName.replace(/\s+/g, '') === wantName)
    if (firstBySender) return from(firstBySender)
  }

  // ⑤ 兜底
  return fallback
}

/**
 * 截取「任务原文」片段。
 * 为什么不是整段对话：详情页要展示的是**任务是怎么被发布的**，
 * 整段聊天会把无关闲聊也塞进去；而且原文会被累积进任务记录，
 * 越长越占地方。所以取「发布那条消息起、随后一小段时间内」的内容。
 */
export function buildOriginalSnippet(
  publisher: TaskPublisher,
  usedMessages: ChatMessage[],
  opts: { maxMessages?: number; maxMinutes?: number; maxChars?: number } = {}
): string {
  const maxMessages = opts.maxMessages ?? 15
  const maxMinutes = opts.maxMinutes ?? 20
  const maxChars = opts.maxChars ?? 2000

  const idx = publisher.messageId
    ? usedMessages.findIndex((m) => m.id === publisher.messageId)
    : -1

  // 找不到那条消息时，退化为「该发送者最后出现的位置」，再退化到末尾若干条
  const startIdx =
    idx >= 0
      ? idx
      : (() => {
          const bySender = usedMessages.map((m, i) => ({ m, i })).filter((x) => x.m.senderName === publisher.name)
          return bySender.length > 0 ? bySender[bySender.length - 1].i : Math.max(0, usedMessages.length - maxMessages)
        })()

  const slice: ChatMessage[] = []
  const t0 = usedMessages[startIdx]?.timestamp ?? 0
  for (let i = startIdx; i < usedMessages.length && slice.length < maxMessages; i++) {
    const m = usedMessages[i]
    if (t0 && m.timestamp - t0 > maxMinutes * 60_000) break
    slice.push(m)
  }

  const lines = slice.map((m) => {
    const who = m.isSelf ? `${m.senderName || '我'}（本人）` : m.senderName || '未知'
    const body = m.text.replace(/\s*\n+\s*/g, ' ').trim()
    return `[${formatDateTime(m.timestamp)}] ${who}: ${body}`
  })

  let text = lines.join('\n')
  if (text.length > maxChars) {
    // 超长时截断并注明，避免把整段聊天塞进任务记录
    text = `${text.slice(0, maxChars)}\n…（原文较长，已截断）`
  }
  return text
}

/** 把解析结果 + 回查到的发布人组装成 TaskDraft */
export function toTaskDraft(
  parsed: ParsedRawTask,
  publisher: TaskPublisher,
  usedMessages: ChatMessage[],
  parseTimestamp: (text: string, endOfDay?: boolean) => number | undefined
): TaskDraft {
  return {
    name: parsed.name || parsed.topic || '未命名任务',
    topic: parsed.topic,
    type: parsed.type || '其他',
    organizers: parsed.organizers,
    startAt: parseTimestamp(parsed.startAtText),
    // 截止时间按「当天结束」处理：原文只写日期时，应到当天 23:59 才过期
    endAt: parseTimestamp(parsed.endAtText, true),
    materials: parsed.materials,
    contactPerson: parsed.contactPerson || undefined,
    // 原文只取任务发布处附近的片段，用于详情页展示
    originalText: buildOriginalSnippet(publisher, usedMessages),
    confidence: parsed.confidence
  }
}
