/**
 * 手动任务（第二次更新需求 §1）
 * ==================================================================
 * 需求原文：
 *   「在"抓取任务"按钮旁，设置一个"新增任务"按钮，样式与"抓取任务"按钮相同，
 *     点击后可以新建一个任务，并打开任务详情面板以供用户填入信息，可填写的信息
 *     种类与自动抓取到的相同。对于用户没有填写的关键信息（要显示在缩略中的信息），
 *     在缩略中像原来设计的一样表明信息未明确。如果是名称或主题未填写，则调用 AI
 *     生成名称、主题。相关信息在填写后自动保存。」
 *
 * 本模块只做两件事：
 *   1. createManualTask()  —— 建一条空的 manual 任务并落库，返回给界面打开详情面板
 *   2. suggestMeta()       —— 名称/主题为空时，调用当前激活的 LLM 生成它们
 *
 * 与自动抽取的关系：
 *   - 自动抽取走 tasks/extractor.ts（origin='auto'，带来源消息/发布人）
 *   - 手动新建走这里（origin='manual'，无来源，可自由编辑）
 *   两者共用同一张表、同一套字段，因此界面/详情/去重逻辑都无需分叉。
 */
import type { Task } from '@shared/types'
import { errors } from '../core/errors'
import { scoped } from '../core/logger'
import { getSettings } from '../core/settings'
import { queryOne } from '../core/store'
import { getPlainKey, getKeyRecord } from '../data/llm-repo'
import { insertTask } from '../data/task-repo'
import { chat, PROVIDERS } from '../llm'

const log = scoped('manual-task')

/** 生成一个稳定的随机 id（手动任务不需要与平台 id 关联） */
function newId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `manual-${Date.now().toString(36)}-${rand}`
}

/** 取下一个磁贴序号（排在现有任务之后） */
function nextTileOrder(): number {
  const row = queryOne<{ m: number | null }>('SELECT MAX(tile_order) AS m FROM tasks')
  return (row?.m ?? 0) + 1
}

/**
 * 新建一条空白的手动任务。
 *
 * 设计取舍：名字留空字符串（而不是"未命名任务"），这样界面可以统一用
 * task-labels 里的「未明确」文案渲染，且能区分"用户还没填"与"用户真的叫这个名字"。
 * 数据库 name 列是 NOT NULL，空串合法。
 */
export function createManualTask(): Task {
  const now = Date.now()
  const task: Task = {
    id: newId(),
    origin: 'manual',
    name: '',
    topic: '',
    type: '',
    organizers: [],
    startAt: undefined,
    endAt: undefined,
    materials: [],
    contactPerson: undefined,
    originalText: '',
    publishers: [],
    sourceMessageIds: [],
    status: 'ongoing',
    statusLocked: false,
    deleted: false,
    tileOrder: nextTileOrder(),
    fingerprint: '',
    confidence: undefined,
    createdAt: now,
    updatedAt: now
  }
  insertTask(task)
  log.info('已新建手动任务（空白）', { id: task.id, tileOrder: task.tileOrder })
  return task
}

/** suggestMeta 的输入：用户在新建/编辑面板里填了哪些信息 */
export interface SuggestMetaInput {
  name?: string
  topic?: string
  type?: string
  organizers?: string[]
  contactPerson?: string
  /** 起止时间的可读文本（已格式化），仅作为给模型的上下文 */
  timeText?: string
}

export interface SuggestMetaResult {
  name: string
  topic: string
  /** 实际使用的模型（便于界面提示），未调用 LLM 时为 undefined */
  model?: string
}

/**
 * 名称/主题缺失时，调用当前激活的 LLM 生成它们。
 *
 * 返回 null 表示"无法生成"（未配置 LLM、调用失败等）——调用方据此保持原样，
 * 不应把它当成错误弹窗打扰用户（需求：AI 只是辅助，缺失信息照样允许保存）。
 */
export async function suggestMeta(input: SuggestMetaInput): Promise<SuggestMetaResult | null> {
  const settings = getSettings()
  const provider = settings.activeLlm
  if (!provider) {
    log.info('未配置 LLM 平台，跳过 AI 生成名称/主题')
    return null
  }
  const apiKey = getPlainKey(provider)
  if (!apiKey) {
    log.info('所选平台尚未配置 API Key，跳过 AI 生成名称/主题', { provider })
    return null
  }
  const model = getKeyRecord(provider)?.model || PROVIDERS[provider]?.defaultModel
  if (!model) {
    log.warn('未找到可用模型，跳过 AI 生成名称/主题', { provider })
    return null
  }

  const system =
    '你是一个中文任务信息整理助手。用户会给出一个任务的零散信息，请你据此生成：' +
    '（1）一个**简洁直观**的任务名称（不超过 20 字，不要加书名号/引号）；' +
    '（2）一句话任务主题（不超过 40 字，概括这个任务要做什么）。' +
    '若用户已给出名称或主题，则尊重已有内容、只补另一项。' +
    '只输出 JSON，形如 {"name":"...","topic":"..."}，不要输出任何解释。'

  const lines: string[] = []
  if (input.name) lines.push(`已有名称：${input.name}`)
  if (input.topic) lines.push(`已有主题：${input.topic}`)
  if (input.type) lines.push(`类型：${input.type}`)
  if (input.organizers?.length) lines.push(`负责人/组织：${input.organizers.join('、')}`)
  if (input.contactPerson) lines.push(`接头人：${input.contactPerson}`)
  if (input.timeText) lines.push(`起止时间：${input.timeText}`)
  const user = lines.length ? lines.join('\n') : '（用户没有提供额外信息，请生成一个通用的任务名称与主题）'

  try {
    log.info('调用 LLM 生成任务名称/主题', { provider, model })
    const res = await chat({
      provider,
      apiKey,
      model,
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.4,
      maxTokens: 256,
      jsonMode: true,
      timeoutMs: settings.ioTimeoutMs
    })
    const parsed = extractJson(res.text)
    if (!parsed) {
      log.warn('AI 生成名称/主题返回了无法解析的内容', { text: res.text.slice(0, 200) })
      return null
    }
    const name = (input.name || String(parsed.name ?? '')).trim().slice(0, 60)
    const topic = (input.topic || String(parsed.topic ?? '')).trim().slice(0, 120)
    log.info('AI 已生成名称/主题', { name, topic, model: res.model })
    return { name, topic, model: res.model }
  } catch (e) {
    // 生成失败不是致命错误：用户可以先保存，稍后手动补
    log.warn('AI 生成名称/主题失败', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/** 从模型输出里抠出 JSON（容忍 ```json 代码块与前后杂质） */
function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()
  try {
    return JSON.parse(candidate) as Record<string, unknown>
  } catch {
    // 退一步：取第一个 { 到最后一个 } 之间的内容
    const s = candidate.indexOf('{')
    const e = candidate.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(candidate.slice(s, e + 1)) as Record<string, unknown>
      } catch {
        return null
      }
    }
    return null
  }
}

/** 供上层做参数校验的入口（保持与其它模块一致的错误风格） */
export function assertManualTaskEditable(task: Task): void {
  if (task.origin !== 'manual' && task.origin !== 'auto') {
    throw errors.invalidArg('任务来源非法', `origin=${task.origin}`)
  }
}
