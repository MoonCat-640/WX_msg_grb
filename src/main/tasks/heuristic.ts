/**
 * 规则兜底抽取（无需 LLM）
 * ------------------------------------------------------------------
 * 用途：
 *   1) 演示数据模式（mockMode）下，没有任何 API Key 也能跑通「聊天 → 任务」全链路，
 *      方便调试界面与交互
 *   2) LLM 不可用时（没钱/断网/限流）仍能给出粗略结果，而不是空白界面
 *
 * 明确说明：这是**粗糙的启发式规则**，准确率远低于 LLM，
 * 界面上会标注「规则抽取」，不要拿它当正式结果使用。
 */
import type { ChatMessage, TaskDraft, TaskMaterial } from '@shared/types'
import { parseUtc8 } from '@shared/time'

/** 触发「这可能是个任务」的关键词 */
const TASK_HINTS = [
  '报名', '提交', '截止', '务必', '请于', '请在', '需要', '材料', '表格', '表单',
  '问卷', '填写', '填写表格', '会议', '开会', '讲座', '答辩', '面试', '缴费', '交费',
  '领取', '办理', '上交', '汇总', '统计', '参加', '参与', '培训', '考试', '竞赛', '申请',
  '通知', '安排', '统计表', '汇总表', '回执', '签字', '确认'
]

/** 用于判断类型的规则（顺序即优先级） */
const TYPE_RULES: { type: string; words: string[] }[] = [
  { type: '报名', words: ['报名', '参赛', '参加', '申请', '登记'] },
  { type: '材料提交', words: ['提交', '上交', '递交', '材料', '汇总', '统计表', '回执', '签字'] },
  { type: '表单填写', words: ['填写', '填表', '表单', '问卷', '表格', '共享表格', '在线文档'] },
  { type: '会议', words: ['开会', '会议', '讲座', '答辩', '面试', '例会', '培训'] },
  { type: '缴费', words: ['缴费', '交费', '费用', '报名费'] },
  { type: '领取', words: ['领取', '发放', '领取时间'] },
  { type: '考试', words: ['考试', '考核', '测验'] }
]

/** URL 匹配（覆盖 http(s) 与常见的短链/文档站） */
const URL_RE = /https?:\/\/[^\s"'<>）)】\]]+/g

/** 从一条消息里抽取时间点（返回 UTC+8 毫秒时间戳） */
function extractTimes(text: string, baseTs: number): { startAt?: number; endAt?: number } {
  const result: { startAt?: number; endAt?: number } = {}

  // 1) 显式日期：2026-09-30 / 9月30日 / 09/30
  const explicit = [
    ...text.matchAll(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/g)
  ]
  if (explicit.length > 0) {
    const dates = explicit
      .map((m) => parseUtc8(`${m[1]}-${m[2]}-${m[3]}`, true))
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b)
    if (dates.length > 0) {
      result.startAt = dates[0]
      result.endAt = dates[dates.length - 1]
      return result
    }
  }

  // 2) 相对日期：今天/明天/后天/本周X/下周一
  const base = new Date(baseTs + 8 * 3600 * 1000)
  const baseDayStart = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate()
  ) - 8 * 3600 * 1000

  const rel = text.match(/(今天|今日|明天|明日|后天|大后天|本周[一二三四五六日天]|下周[一二三四五六日天]|周[一二三四五六日天])/)
  if (rel) {
    const k = rel[1]
    const day = 24 * 3600 * 1000
    let offset = 0
    if (k === '今天' || k === '今日') offset = 0
    else if (k === '明天' || k === '明日') offset = 1
    else if (k === '后天') offset = 2
    else if (k === '大后天') offset = 3
    else {
      const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
      const target = map[k.replace(/^(本周|下周|周)/, '')]
      const todayDow = base.getUTCDay() === 0 ? 7 : base.getUTCDay()
      // 本周三 = 跨到下一个周三；下周X 再加一周
      offset = ((target - todayDow + 7) % 7) + (k.startsWith('下周') ? 7 : 0)
    }
    result.endAt = baseDayStart + offset * day + day - 1
    return result
  }

  // 3) 只有「X月X日前」形式
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*前?/)
  if (monthDay) {
    const year = base.getUTCFullYear()
    const ts = parseUtc8(`${year}-${monthDay[1]}-${monthDay[2]}`, true)
    if (ts !== undefined) {
      result.endAt = ts
      return result
    }
  }

  return result
}

/** 抽取材料清单（从 URL + 常见名词） */
function extractMaterials(text: string): TaskMaterial[] {
  const out: TaskMaterial[] = []
  const urls = text.match(URL_RE) ?? []
  for (const url of urls.slice(0, 6)) {
    // 猜一下类型：问卷/表单类的链接肯定是 form
    const isForm = /wjx|wenjuan|问卷|forms?\.|kdocs|docs\.qq|shimo|feishu|larksuite|腾讯文档|f\.|surveymonkey/i.test(url)
    out.push({
      name: inferMaterialName(text, url),
      kind: isForm ? 'form' : 'link',
      url,
      required: true
    })
  }

  // 常见材料的显式提及（去掉已被 URL 覆盖的）
  const nounRules: { re: RegExp; kind: TaskMaterial['kind'] }[] = [
    { re: /(申请表|报名表|登记表|汇总表|统计表)/, kind: 'document' },
    { re: /(一寸照片|两寸照片|证件照|照片)/, kind: 'document' },
    { re: /(身份证复印件|复印件)/, kind: 'document' },
    { re: /(成绩单|证书|证明材料|简历)/, kind: 'document' },
    { re: /(纸质|打印|签名|签字)/, kind: 'offline' }
  ]
  for (const rule of nounRules) {
    const m = text.match(rule.re)
    if (m && !out.some((o) => o.name.includes(m[1]))) {
      out.push({ name: m[1], kind: rule.kind, required: true })
    }
  }
  return out
}

/** 从链接附近猜测材料名 */
function inferMaterialName(text: string, url: string): string {
  const idx = text.indexOf(url)
  const around = idx >= 0 ? text.slice(Math.max(0, idx - 12), idx) : ''
  if (/问卷/.test(text)) return '线上问卷'
  if (/报名/.test(around) || /报名/.test(text)) return '报名链接'
  if (/表格|共享|文档/.test(around)) return '共享表格'
  return '相关链接'
}

/** 归纳任务类型 */
function inferType(text: string): string {
  for (const rule of TYPE_RULES) {
    if (rule.words.some((w) => text.includes(w))) return rule.type
  }
  return '其他'
}

/** 归纳任务名称：取首句的核心片段 */
function inferName(text: string, type: string): string {
  // 去掉开头 @某人 的提及
  let s = text.replace(/^@\S+\s*/g, '').trim()
  // 库库开头常见的【】标题
  const bracket = s.match(/^【([^】]{2,20})】/)
  if (bracket) return bracket[1]

  // 取第一个句子
  const firstSentence = s.split(/[。！？\n；;]/)[0].trim()
  s = firstSentence || s
  // 去掉纯标点
  s = s.replace(/^[\s\-—:：,，]+/, '').replace(/[\s\-—:：,，]+$/, '')
  if (s.length > 22) s = `${s.slice(0, 22)}…`
  return s || `${type}任务`
}

/** 规则抽取的命中项：草稿 + 它来自哪条消息（发布人回查要用） */
export interface HeuristicHit {
  draft: TaskDraft
  message: ChatMessage
}

/**
 * 对一段消息做规则抽取。
 * 只处理「看起来像任务」的消息，避免把整段聊天都变成任务。
 */
export function heuristicExtract(messages: ChatMessage[]): HeuristicHit[] {
  const hits: HeuristicHit[] = []

  for (const m of messages) {
    if (m.kind === 'system') continue
    const text = (m.text ?? '').trim()
    if (text.length < 6) continue

    const hitCount = TASK_HINTS.filter((w) => text.includes(w)).length
    const hasUrl = URL_RE.test(text) && /(报名|问卷|表格|填写|提交|链接)/.test(text)
    URL_RE.lastIndex = 0 // 正则带 g 标志，test 会移动 lastIndex，必须复位

    // 至少命中一个任务关键词，或同时含链接与动作词
    if (hitCount === 0 && !hasUrl) continue

    const type = inferType(text)
    const { startAt, endAt } = extractTimes(text, m.timestamp)
    const materials = extractMaterials(text)

    hits.push({
      message: m,
      draft: {
        name: inferName(text, type),
        topic: text.replace(/\s+/g, ' ').slice(0, 40),
        type,
        organizers: [],
        startAt,
        endAt,
        materials,
        // 原文直接用这条消息（后处理阶段会替换为附近片段）
        originalText: text,
        // 规则抽取的可信度天然较低，明确标出来
        confidence: Math.min(
          0.55,
          0.2 + hitCount * 0.1 + (endAt ? 0.1 : 0) + (materials.length > 0 ? 0.05 : 0)
        )
      }
    })
  }

  // 同一条消息可能命中多次规则，按名称去重
  const seen = new Set<string>()
  return hits.filter((h) => {
    const k = h.draft.name
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
