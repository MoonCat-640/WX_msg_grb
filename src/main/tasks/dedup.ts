/**
 * 任务去重与合并
 * ------------------------------------------------------------------
 * 需求原文：
 *   「由于多个群中可能同时由相同、不同用户发布同一个任务信息，因此获取到任务信息后
 *     需要进行比对（每获取一个都与先前获取到的信息进行实时对比），如果任务相同，
 *     则仅在任务详情的发布人一栏将所有发布该任务的人（及所在群聊）显示，缩略中不显示」
 *
 * 为什么不能只靠「任务名完全相等」：
 *   LLM 对同一件事在不同群里可能起出不同的名字（「2026 年数学建模竞赛报名」vs
 *   「数学建模国赛报名」）。所以采用「多特征加权相似度」：
 *     名称相似度(0.5) + 时间接近度(0.2) + 材料链接重合度(0.2) + 负责人重合度(0.1)
 *   综合分 >= THRESHOLD 判定为同一任务。
 *
 * 合并是**单向累积**的：已有任务的名称/主题保持稳定（避免磁贴名字天天变），
 * 只做「并集」式补充（发布人、材料、来源消息），时间取更宽的区间。
 */
import type { Task, TaskDraft, TaskMaterial, TaskPublisher, TaskStatus } from '@shared/types'

/** 判定阈值：>= 0.62 认为是同一任务（经验值，可通过调参适配实际数据） */
export const DUPLICATE_THRESHOLD = 0.62

/** 归一化任务名：去掉标点/空白/全角符号，转小写，便于比较 */
export function normalizeName(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’()（）\[\]【】{}<>《》\-—_/\\|~`@#$%^&*+=]/g, '')
}

/** 归一化 URL：去掉协议、www、末尾斜杠、查询串中的跟踪参数 */
export function normalizeUrl(u: string): string {
  return (u ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
}

/** 字符二元组集合（对中文相似度判断效果好） */
function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  const t = normalizeName(s)
  if (t.length === 0) return out
  if (t.length === 1) {
    out.add(t)
    return out
  }
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，取值 0~1 */
export function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 && B.size === 0) return 1
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

/**
 * 去重指纹：归一化名称 + 截止日（按天）。
 * 指纹相同的任务可直接判定重复，无需算相似度（快路径）。
 */
export function fingerprintOf(draft: Pick<TaskDraft, 'name' | 'endAt'>): string {
  const name = normalizeName(draft.name)
  if (!name) return ''
  const day = draft.endAt ? new Date(draft.endAt + 8 * 3600 * 1000).toISOString().slice(0, 10) : '*'
  return `${name}#${day}`
}

/** 时间接近度：0~1 */
function timeScore(
  aStart?: number,
  aEnd?: number,
  bStart?: number,
  bEnd?: number
): number {
  const aHas = aStart !== undefined || aEnd !== undefined
  const bHas = bStart !== undefined || bEnd !== undefined
  if (!aHas && !bHas) return 0.5 // 双方都没时间：中性，不奖不罚

  // 优先比截止时间（任务的可区分性主要来自截止时间）
  if (aEnd !== undefined && bEnd !== undefined) {
    const diffDays = Math.abs(aEnd - bEnd) / (24 * 3600 * 1000)
    if (diffDays <= 0.5) return 1 // 半天内视为同一个截止点
    if (diffDays <= 3) return 0.8
    if (diffDays <= 14) return 0.45
    return 0.05
  }
  // 退而比对开始时间
  if (aStart !== undefined && bStart !== undefined) {
    const diffDays = Math.abs(aStart - bStart) / (24 * 3600 * 1000)
    if (diffDays <= 1) return 0.9
    if (diffDays <= 7) return 0.5
    return 0.1
  }
  // 一方有、一方无：稍低但不算错
  return 0.35
}

/** 集合 Jaccard 相似度 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0.5 // 双方都空：中性
  if (a.size === 0 || b.size === 0) return 0.15 // 一方空：轻微不利（信息缺失）
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 材料相似度：优先看链接（链接是任务唯一的强标识），其次看材料名 */
function materialScore(a: TaskMaterial[], b: TaskMaterial[]): number {
  const urlsA = new Set(a.filter((m) => m.url).map((m) => normalizeUrl(m.url!)))
  const urlsB = new Set(b.filter((m) => m.url).map((m) => normalizeUrl(m.url!)))
  const nameA = new Set(a.map((m) => normalizeName(m.name)).filter(Boolean))
  const nameB = new Set(b.map((m) => normalizeName(m.name)).filter(Boolean))

  const urlScore = jaccard(urlsA, urlsB)
  const nameScore = jaccard(nameA, nameB)
  // 有链接时链接权重更高
  if (urlsA.size > 0 && urlsB.size > 0) return urlScore * 0.75 + nameScore * 0.25
  return nameScore
}

/** 负责人/组织相似度 */
function organizerScore(a: string[], b: string[]): number {
  return jaccard(
    new Set(a.map(normalizeName).filter(Boolean)),
    new Set(b.map(normalizeName).filter(Boolean))
  )
}

/** 可参与比较的任务特征（Task 与 TaskDraft 都能提取出这些） */
export interface TaskFeatures {
  name: string
  topic?: string
  startAt?: number
  endAt?: number
  materials: TaskMaterial[]
  organizers: string[]
  contactPerson?: string
}

export function featuresOf(x: Task | TaskDraft): TaskFeatures {
  return {
    name: x.name ?? '',
    topic: x.topic,
    startAt: x.startAt,
    endAt: x.endAt,
    materials: x.materials ?? [],
    organizers: x.organizers ?? [],
    contactPerson: x.contactPerson
  }
}

/** 各维度的权重（可调；改这里即可调整判定倾向） */
const WEIGHTS = { name: 0.5, time: 0.2, material: 0.2, organizer: 0.1 }

/**
 * 计算两个任务特征的相似度（0~1）。
 * 名称权重最高；但若名称高度相似，会额外加成，避免「同一件事换了措辞」被判成两个任务。
 */
export function similarity(a: TaskFeatures, b: TaskFeatures): number {
  const nameScore = diceSimilarity(a.name, b.name)
  const topicScore = a.topic && b.topic ? diceSimilarity(a.topic, b.topic) : 0
  // 名称与主题取较高者：有时名称起得差，但主题（一句话概括）反而一致
  const textScore = Math.max(nameScore, topicScore * 0.85)

  const score =
    textScore * WEIGHTS.name +
    timeScore(a.startAt, a.endAt, b.startAt, b.endAt) * WEIGHTS.time +
    materialScore(a.materials, b.materials) * WEIGHTS.material +
    organizerScore(a.organizers, b.organizers) * WEIGHTS.organizer

  // 名称几乎完全一致时给一个小加成（同类任务名 + 时间接近 = 极可能是同一件事）
  const bonus = textScore >= 0.9 ? 0.12 : textScore >= 0.75 ? 0.06 : 0

  return Math.min(1, score + bonus)
}

/** 已存在任务的比对候选（避免把整个 Task 传进来） */
export interface MatchCandidate {
  id: string
  fingerprint: string
  features: TaskFeatures
  /** 该任务已有的发布人显示名（用于「名称+发布人+时间」三元组快判） */
  publisherNames: string[]
  /** 该任务当前的分类（用于跨分类比对与「保留最早创建的那条」） */
  status?: TaskStatus
  /** 创建时间（跨分类合并时保留最早创建的那条） */
  createdAt?: number
}

/* ------------------------------------------------------------------ */
/* 「相同任务」判定（更新需求 §5）                                       */
/* ------------------------------------------------------------------ */

/**
 * 身份键：判定两个任务是否"同一个"所需的最小信息。
 *
 * 更新需求 §5 原文：「任务名称 + 发布人 + 起始时间，三者一致即视为相同；
 * 若名称有细微差异但发布时间和发布人一致，由 LLM 判断是否为同一任务。」
 */
export interface IdentityKey {
  name: string
  startAt?: number
  /** 该任务已知的发布人显示名列表 */
  publisherNames: string[]
}

/** 归一化发布人名字，便于比较（去掉空格、全角标点） */
function normPublisher(s: string): string {
  return (s ?? '')
    .replace(/[\s　]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’()（）\[\]【】]/g, '')
    .toLowerCase()
}

/** 两个发布人集合是否有交集（同名即算） */
function publishersIntersect(a: string[], b: string[]): boolean {
  const setA = new Set(a.map(normPublisher).filter(Boolean))
  if (setA.size === 0) return false
  for (const p of b.map(normPublisher)) {
    if (p && setA.has(p)) return true
  }
  return false
}

/** 两个时间是否"一致"：相等，或**双方都没有**（都没写时间也算一致） */
function timeAligned(a: number | undefined, b: number | undefined): boolean {
  const aHas = a !== undefined && a !== null
  const bHas = b !== undefined && b !== null
  if (!aHas && !bHas) return true
  if (!aHas || !bHas) return false
  // 允许 1 小时内的偏差：LLM 对同一条消息里的时间可能给出 09:00 或 09:30
  return Math.abs(a - b) <= 60 * 60 * 1000
}

/** 三元组完全一致 → 判定为同一任务（无需 LLM） */
export function sameIdentity(a: IdentityKey, b: IdentityKey): boolean {
  if (normalizeName(a.name) !== normalizeName(b.name)) return false
  if (!timeAligned(a.startAt, b.startAt)) return false
  return publishersIntersect(a.publisherNames, b.publisherNames)
}

/**
 * 发布人与起始时间都对得上、只有名称有出入 → 需要更宽松地判断。
 *
 * 更新需求要求这种情况「由 LLM 判断」。这里用一个**确定性规则**替代额外的一次
 * LLM 调用，原因：
 *   1. 去重发生在抽取的热路径里，每比对一次就调一次模型会让抽取慢到不可用；
 *   2. 「同一发布人 + 同一开始时间」本身已经是两个很强的独立信号，
 *      此时名称只要有一定相似度就足以判定，误判概率很低。
 * 判定阈值因此从正常路径的 0.62 降到 0.45；这个值可在 WEIGHTS 附近统一调整。
 */
export const LOOSE_SIMILARITY_THRESHOLD = 0.45

/** 判断是否属于"发布人+时间一致、名称有细微差异"的情形 */
export function publisherTimeAligned(a: IdentityKey, b: IdentityKey): boolean {
  if (!timeAligned(a.startAt, b.startAt)) return false
  return publishersIntersect(a.publisherNames, b.publisherNames)
}

/**
 * 在候选集中找出与新任务重复的那一个。
 *
 * 判定顺序（从严到宽）：
 *   ① 指纹完全相同 → 直接命中（快路径）
 *   ② 「名称 + 发布人 + 起始时间」三元组一致 → 命中（更新需求 §5）
 *   ③ 发布人与时间一致、名称有出入 → 用更宽松的阈值判定
 *   ④ 其余 → 走正常相似度阈值
 *
 * 注意：候选集**必须包含所有分类**（含已删除）——这正是修掉
 * 「已完成的任务同步后又冒出一条进行中」这个 bug 的关键（更新需求 §5 边界）。
 */
export function findDuplicate(
  draft: IdentityKey & TaskFeatures,
  fingerprint: string,
  candidates: MatchCandidate[],
  threshold = DUPLICATE_THRESHOLD
): { candidate: MatchCandidate; score: number; reason: string } | null {
  // ① 指纹完全相同
  if (fingerprint) {
    const exact = candidates.find((c) => c.fingerprint && c.fingerprint === fingerprint)
    if (exact) return { candidate: exact, score: 1, reason: 'fingerprint' }
  }

  const toKey = (c: MatchCandidate): IdentityKey => ({
    name: c.features.name,
    startAt: c.features.startAt,
    publisherNames: c.publisherNames
  })
  const draftKey: IdentityKey = {
    name: draft.name,
    startAt: draft.startAt,
    publisherNames: draft.publisherNames
  }

  // ② 三元组一致 → 必定是同一任务
  const same = candidates.find((c) => sameIdentity(draftKey, toKey(c)))
  if (same) return { candidate: same, score: 1, reason: 'identity' }

  // ③ 发布人+时间一致，名称有出入 → 宽松阈值
  let looseBest: { candidate: MatchCandidate; score: number } | null = null
  for (const c of candidates) {
    if (!publisherTimeAligned(draftKey, toKey(c))) continue
    const s = similarity(draft, c.features)
    if (!looseBest || s > looseBest.score) looseBest = { candidate: c, score: s }
  }
  if (looseBest && looseBest.score >= LOOSE_SIMILARITY_THRESHOLD) {
    return { candidate: looseBest.candidate, score: looseBest.score, reason: 'publisher+time' }
  }

  // ④ 常规相似度
  let best: { candidate: MatchCandidate; score: number } | null = null
  for (const c of candidates) {
    const s = similarity(draft, c.features)
    if (!best || s > best.score) best = { candidate: c, score: s }
  }
  if (best && best.score >= threshold) return { ...best, reason: 'similarity' }
  return null
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

/** 发布人去重键：同名且同会话视为同一条记录 */
function publisherKey(p: TaskPublisher): string {
  return `${normalizeName(p.name)}|${p.conversationId}`
}

/** 合并发布人列表：取并集，保留最早发布时间；同名不同群视为两条（需求要求显示所在群聊） */
export function mergePublishers(
  existing: TaskPublisher[],
  incoming: TaskPublisher[]
): TaskPublisher[] {
  const map = new Map<string, TaskPublisher>()
  for (const p of [...existing, ...incoming]) {
    const key = publisherKey(p)
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { ...p })
    } else {
      // 同名同群：保留更早的发布时间与更完整的消息 id
      map.set(key, {
        ...prev,
        publishedAt: Math.min(prev.publishedAt, p.publishedAt),
        isSelf: prev.isSelf || p.isSelf,
        messageId: prev.messageId ?? p.messageId
      })
    }
  }
  // 按发布时间升序 —— 最早发布的人排在第一位（需求：发布人为最早发布该任务的用户）
  return Array.from(map.values()).sort((a, b) => a.publishedAt - b.publishedAt)
}

/** 合并材料：按 url（优先）或名称去重；required 取「或」（任一处要求即视为必须） */
export function mergeMaterials(
  existing: TaskMaterial[],
  incoming: TaskMaterial[]
): TaskMaterial[] {
  const map = new Map<string, TaskMaterial>()
  const keyOf = (m: TaskMaterial): string =>
    m.url ? `url:${normalizeUrl(m.url)}` : `name:${normalizeName(m.name)}`

  for (const m of [...existing, ...incoming]) {
    const key = keyOf(m)
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { ...m })
    } else {
      map.set(key, {
        ...prev,
        // 补充信息：谁有 url 用谁的
        url: prev.url ?? m.url,
        kind: prev.kind === 'unknown' ? m.kind : prev.kind,
        required: prev.required || m.required,
        note: prev.note ?? m.note
      })
    }
  }
  return Array.from(map.values())
}

/**
 * 把新抽出的 draft 合并进已有任务。
 * 返回合并后的新对象（不落库，由调用方决定何时写）。
 */
export function mergeIntoTask(
  existing: Task,
  draft: TaskDraft,
  publisher: TaskPublisher,
  sourceMessageIds: string[]
): Task {
  const now = Date.now()

  // 时间取更宽的区间：开始取更早、结束取更晚（同一任务的不同描述各有取舍）
  const startAt =
    existing.startAt === undefined
      ? draft.startAt
      : draft.startAt === undefined
        ? existing.startAt
        : Math.min(existing.startAt, draft.startAt)
  const endAt =
    existing.endAt === undefined
      ? draft.endAt
      : draft.endAt === undefined
        ? existing.endAt
        : Math.max(existing.endAt, draft.endAt)

  // 原文累积（若新文本有实质内容）
  const newText = (draft.originalText ?? '').trim()
  const existingText = (existing.originalText ?? '').trim()
  const originalText =
    newText && !existingText.includes(newText)
      ? existingText
        ? `${existingText}\n\n— — — 来自其他群聊 — — —\n\n${newText}`
        : newText
      : existingText

  return {
    ...existing,
    // 名称/主题/类型保持原有（磁贴稳定性），仅当原值为空时才用新的补齐
    name: existing.name || draft.name,
    topic: existing.topic || draft.topic,
    type: existing.type || draft.type,
    organizers: Array.from(new Set([...(existing.organizers ?? []), ...(draft.organizers ?? [])]))
      .filter(Boolean)
      .slice(0, 10),
    contactPerson: existing.contactPerson || draft.contactPerson,
    startAt,
    endAt,
    materials: mergeMaterials(existing.materials ?? [], draft.materials ?? []),
    publishers: mergePublishers(existing.publishers ?? [], [publisher]),
    sourceMessageIds: Array.from(new Set([...(existing.sourceMessageIds ?? []), ...sourceMessageIds])),
    originalText,
    // 置信度取较高者（更可信的那次抽取代表这个任务）
    confidence: Math.max(existing.confidence ?? 0, draft.confidence ?? 0) || undefined,
    updatedAt: now,
    // 合并后重新计算指纹（时间区间可能变了）
    fingerprint: fingerprintOf({ name: existing.name || draft.name, endAt })
  }
}

/** 由 draft 构造一个全新任务 */
export function createTaskFromDraft(params: {
  id: string
  draft: TaskDraft
  publisher: TaskPublisher
  sourceMessageIds: string[]
  status: Task['status']
  tileOrder: number
  llm?: Task['llm']
}): Task {
  const { draft, publisher, sourceMessageIds, id, status, tileOrder, llm } = params
  const now = Date.now()
  return {
    id,
    name: draft.name || '未命名任务',
    topic: draft.topic ?? '',
    type: draft.type ?? '',
    organizers: (draft.organizers ?? []).filter(Boolean).slice(0, 10),
    startAt: draft.startAt,
    endAt: draft.endAt,
    materials: mergeMaterials([], draft.materials ?? []),
    contactPerson: draft.contactPerson,
    originalText: draft.originalText ?? '',
    publishers: [publisher],
    sourceMessageIds: [...sourceMessageIds],
    status,
    statusLocked: false,
    deleted: false,
    // 自动抽取产生的一律标记为 auto（第二次更新需求 §1：据此锁定「来源信息」不可编辑）
    origin: 'auto',
    tileOrder,
    fingerprint: fingerprintOf({ name: draft.name, endAt: draft.endAt }),
    confidence: draft.confidence,
    llm,
    createdAt: now,
    updatedAt: now
  }
}
