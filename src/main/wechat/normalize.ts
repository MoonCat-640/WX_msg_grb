/**
 * 上游原始数据 → 本项目领域模型的归一化（纯函数，不依赖 electron）
 * ------------------------------------------------------------------
 * 设计原则：
 *   1. **防御性读取**：上游是第三方程序，字段可能缺、可能是 null、类型可能变。
 *      这里所有取值都走 firstNonEmpty / num 之类的安全函数，缺字段给合理默认值。
 *   2. **消息类型与 UI 解耦**：上游的 local_type 编码很杂（见契约文档 §D.4），
 *      统一映射到 MessageKind；49（appmsg）还要看 xml_parsed.render_type 细分。
 *   3. **messageToText 的质量直接决定 LLM 抽取效果**，必须覆盖所有类型与 49 的子类型。
 *
 * 职责边界：本文件只做「单条消息/单个会话」的转换，**不负责拼给 LLM 的整段
 * transcript**（那属于任务抽取层）。
 */
import type { ChatMessage, Conversation, MessageKind, PlatformId } from '@shared/types'
import type { RawContact, RawMessage, RawMediaInfo } from './types'

/* ==================================================================
 * 小工具
 * ================================================================== */

/** 安全转成去空白字符串（非字符串一律当空） */
function s(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** 安全数字：字符串数字也接受，其它返回 null */
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (t && /^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  }
  return null
}

/** 返回第一个非空字符串 */
function firstNonEmpty(...vals: (string | null | undefined)[]): string {
  for (const v of vals) {
    const t = s(v)
    if (t) return t
  }
  return ''
}

/** 合并空白为单个空格，确保输出是「一行」文本 */
function oneLine(v: string): string {
  return v.replace(/\s+/g, ' ').trim()
}

/** 过长的标题/URL 截断，避免单条消息把上下文撑爆 */
function truncate(v: string, n = 60): string {
  const t = oneLine(v)
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function emptyToUndef(v: string | undefined | null): string | undefined {
  const t = s(v)
  return t || undefined
}

/* ==================================================================
 * 时间戳
 * ================================================================== */

/**
 * 上游 create_time → 毫秒。
 * 契约文档 §D.10：正常是 Unix **秒**，但旧数据可能是毫秒，必须容错。
 * 判据：> 1e12 视作已经是毫秒（1e12 秒约等于公元 33658 年，不可能是真实秒级时间戳）。
 */
export function toMillis(ts: number): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 0
  return ts > 1e12 ? Math.round(ts) : Math.round(ts * 1000)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 把毫秒时间戳格式化成 UTC+8 的 `YYYY-MM-DD HH:MM`（定长、分钟精度、补零）。
 *
 * 实现要点：先把毫秒整体 +8 小时，再用 **UTC 取值**——这样输出与运行机器的
 * 本地时区无关，永远是中国标准时间。任务抽取层拼 transcript 时直接用这个函数。
 * 入参是**毫秒**（不是秒）。
 */
export function formatTimestampUtc8(tsMillis: number): string {
  const ms = typeof tsMillis === 'number' && Number.isFinite(tsMillis) ? tsMillis : 0
  const d = new Date(ms + 8 * 3600 * 1000)
  const y = d.getUTCFullYear()
  const mo = pad2(d.getUTCMonth() + 1)
  const day = pad2(d.getUTCDate())
  const h = pad2(d.getUTCHours())
  const mi = pad2(d.getUTCMinutes())
  return `${y}-${mo}-${day} ${h}:${mi}`
}

/* ==================================================================
 * 显示名
 * ================================================================== */

/**
 * 联系人显示名优先级（契约文档 §D.7）：
 *   **备注 remark > 昵称 nick_name > 微信号 alias > 裸 wxid**
 * 过滤掉含替换字符 '�' 的脏值，以及恰好等于原始 wxid 的值（等于没解析）。
 */
export function pickDisplayName(
  remark?: string | null,
  nickName?: string | null,
  alias?: string | null,
  wxid?: string | null
): string {
  const fallback = s(wxid)
  for (const v of [remark, nickName, alias]) {
    const t = s(v)
    if (!t) continue
    if (t.includes('�')) continue
    if (t === fallback) continue
    return t
  }
  return fallback
}

/* ==================================================================
 * 消息类型映射
 * ================================================================== */

/**
 * 上游 msg_type（= local_type & 0xFFFF）→ MessageKind。
 *
 * 注意：上游返回的 msg_type 已经掩码过，这里再 & 0xFFFF 一次纯粹是防御
 * （契约文档 §F.4 第 7 条：新实现必须统一 0xFFFF，别用 0xFFFFFFFF）。
 * 49 的具体含义要看 xml_parsed.render_type（链接/文件/引用/小程序/视频号…）。
 */
export function msgTypeToKind(msgType: number, xmlParsed?: Record<string, any>): MessageKind {
  const t = (typeof msgType === 'number' && Number.isFinite(msgType) ? msgType : 0) & 0xffff
  switch (t) {
    case 1:
      return 'text'
    case 3:
      return 'image'
    case 6:
      return 'file'
    case 34:
      return 'voice'
    case 43:
      return 'video'
    case 47:
      return 'emoji'
    case 48: // 位置
    case 42: // 名片
    case 50: // 网络电话
      return 'other'
    case 10000:
    case 10002:
      return 'system'
    case 49: {
      const rt = s(xmlParsed?.render_type)
      switch (rt) {
        case 'link':
          return 'link'
        case 'file':
          return 'file'
        case 'quote':
          return 'quote'
        case 'mini_program':
          return 'mini-program'
        case 'finder':
          return 'channels'
        case 'chat_history':
        case 'forward':
          return 'other'
        default:
          // 契约要求：其余 49 一律归 link（含 transfer/red_packet/pat/未知子类型）
          return 'link'
      }
    }
    default:
      return 'other'
  }
}

/* ==================================================================
 * 单条消息 → 给 LLM 读的一行文本
 * ================================================================== */

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 语音时长（秒）：优先 XML 的 duration（上游已把 voicelength 毫秒换算成秒） */
function voiceSeconds(xml: Record<string, any>, media: RawMediaInfo | null): number | null {
  const d = num(xml.duration)
  if (d !== null && d > 0) return Math.round(d)
  const ms = num(xml.duration_ms)
  if (ms !== null && ms > 0) return Math.round(ms / 1000)
  const md = num(media?.duration)
  if (md !== null && md > 0) return Math.round(md)
  return null
}

/** 49（appmsg）按 render_type 细分渲染 */
function renderAppMsg49(xml: Record<string, any>, fallbackText: string): string {
  const rt = s(xml.render_type)
  const title = s(xml.title)
  const url = s(xml.url)
  const des = s(xml.des)

  switch (rt) {
    case 'file': {
      const name = firstNonEmpty(title, s(xml.file_path), fallbackText)
      return name ? `[文件: ${truncate(name)}]` : '[文件]'
    }
    case 'quote': {
      // 引用回复：appmsg.title 是回复内容，refermsg.content 是被引用的原文
      const quoted = s(xml.quote_content)
      const reply = firstNonEmpty(title, fallbackText)
      const replyPart = reply ? truncate(reply, 80) : '引用了一条消息'
      const quotedPart = quoted ? `（引用原文：${truncate(quoted, 80)}）` : ''
      return `[引用] ${replyPart}${quotedPart}`
    }
    case 'mini_program': {
      if (!title) return '[小程序]'
      return `[小程序: ${truncate(title)}${url ? ` -> ${truncate(url, 120)}` : ''}]`
    }
    case 'finder': {
      if (!title) return '[视频号]'
      return `[视频号: ${truncate(title)}${url ? ` -> ${truncate(url, 120)}` : ''}]`
    }
    case 'chat_history':
      return title ? `[合并转发消息: ${truncate(title)}]` : '[合并转发消息]'
    case 'forward': {
      const cnt = num(xml.forward_msg_count)
      if (title) return `[合并转发消息: ${truncate(title)}${cnt ? ` x${cnt}` : ''}]`
      return cnt ? `[合并转发消息 x${cnt}]` : '[合并转发消息]'
    }
    case 'pat':
      return '[拍一拍]'
    case 'transfer': {
      const amount = s(xml.amount)
      return amount ? `[转账: ${truncate(amount)}]` : '[转账]'
    }
    case 'red_packet':
      return title ? `[红包: ${truncate(title)}]` : '[红包]'
    case 'location_share':
      return title ? `[位置共享: ${truncate(title)}]` : '[位置共享]'
    case 'link':
    default: {
      // 49 默认按链接处理（含子类型 3/4/5/68 等文章/网页分享）
      const label = firstNonEmpty(title, des, fallbackText)
      if (!label) return url ? `[链接: ${truncate(url, 120)}]` : '[链接]'
      return `[链接: ${truncate(label)}${url ? ` -> ${truncate(url, 120)}` : ''}]`
    }
  }
}

/**
 * 把一条消息转成给 LLM 读的**一行**文本。
 *
 * 这是 ChatMessage.text 的取值来源，也是 LLM 最终看到的内容，所以：
 *   - 文本消息直接给 content（content 已被上游剥离群聊 "wxid:\n" 前缀）
 *   - 媒体消息给可读占位描述（尽量从 xml_parsed 取标题/文件名/时长/地点/url）
 *   - 系统消息统一 `[系统] ...` 前缀
 *   - 合并空白为单行，避免破坏上层「一行一条消息」的排版
 * 覆盖契约文档 §D.4 中列出的全部类型以及 49 的所有子类型。
 */
export function messageToText(raw: RawMessage): string {
  const t = (typeof raw.msg_type === 'number' && Number.isFinite(raw.msg_type) ? raw.msg_type : 0) & 0xffff
  const xml: Record<string, any> =
    raw.xml_parsed && typeof raw.xml_parsed === 'object' ? raw.xml_parsed : {}
  const media: RawMediaInfo | null = raw.media_info ?? null
  const content = oneLine(s(raw.content))
  const contentRaw = oneLine(s(raw.content_raw))
  const text = content || contentRaw

  switch (t) {
    case 1:
      return text || '[文本]'

    case 3:
      // 图片无额外可读文本；尺寸对任务抽取无意义，故不展开
      return '[图片]'

    case 34: {
      const dur = voiceSeconds(xml, media)
      return dur ? `[语音 ${dur}″]` : '[语音]'
    }

    case 43: {
      const dur = num(xml.duration) ?? num(media?.duration)
      return dur && dur > 0 ? `[视频 ${Math.round(dur)}″]` : '[视频]'
    }

    case 6: {
      const name = firstNonEmpty(s(xml.title), s(media?.file_name))
      const size = formatSize(num(xml.size) ?? num(media?.file_size))
      if (!name) return '[文件]'
      return `[文件: ${truncate(name)}${size ? ` (${size})` : ''}]`
    }

    case 47:
      return '[表情]'

    case 48: {
      const place = firstNonEmpty(
        s(xml.poiname),
        s(xml.label),
        s(xml.text).replace(/^\[位置\]\s*/, '')
      )
      return place ? `[位置: ${truncate(place, 80)}]` : '[位置]'
    }

    case 42: {
      const nick = firstNonEmpty(s(xml.nickname), s(xml.username))
      return nick ? `[名片: ${truncate(nick)}]` : '[名片]'
    }

    case 50: {
      const msg = s(xml.call_msg)
      const dur = num(xml.duration)
      const durPart = dur && dur > 0 ? ` ${Math.round(dur)}″` : ''
      return msg ? `[网络电话: ${truncate(msg, 80)}${durPart}]` : `[网络电话${durPart}]`
    }

    case 10000:
    case 10002: {
      const sys = firstNonEmpty(s(xml.text), s(xml.display_text), s(xml.revoke_content), text)
      const body = sys.replace(/^\[系统\]\s*/, '')
      return body ? `[系统] ${truncate(body, 120)}` : '[系统消息]'
    }

    case 49:
      return renderAppMsg49(xml, text)

    default:
      // 未知类型：尽量给点信息，别让 LLM 看到空白
      return text || `[消息类型 ${t}]`
  }
}

/* ==================================================================
 * 归一化：会话 / 消息
 * ================================================================== */

/**
 * RawContact → Conversation。
 * 显示名优先级由 pickDisplayName 保证；群聊判定看 type/is_group/@chatroom 三处线索。
 */
export function normalizeConversation(
  accountId: string,
  platform: PlatformId,
  raw: RawContact
): Conversation {
  const platformConversationId = firstNonEmpty(raw.id, raw.wxid)
  const isGroup =
    raw.type === 'group' || raw.is_group === true || platformConversationId.endsWith('@chatroom')

  const rawWxid = firstNonEmpty(raw.wxid, raw.id)
  // 仅当上游给了更细的备注/昵称/别名时才走本地解析，否则直接用上游解析好的 display_name/name
  const hasDetail = firstNonEmpty(raw.remark, raw.nick_name, raw.alias) !== ''
  const picked = hasDetail ? pickDisplayName(raw.remark, raw.nick_name, raw.alias, rawWxid) : ''
  const name = firstNonEmpty(picked, raw.display_name, raw.name, rawWxid)

  const lastMsg = num(raw.last_msg_time)
  const cached = num(raw.msg_count)

  return {
    id: `${accountId}:${platformConversationId}`,
    accountId,
    platform,
    platformConversationId,
    kind: isGroup ? 'group' : 'contact',
    name: name || platformConversationId,
    remark: emptyToUndef(raw.remark),
    nickname: emptyToUndef(raw.nick_name),
    memberCount: undefined,
    lastMessageAt: lastMsg && lastMsg > 0 ? toMillis(lastMsg) : undefined,
    selected: false,
    cachedMessageCount: cached !== null && cached >= 0 ? cached : undefined
  }
}

/**
 * RawMessage → ChatMessage。
 *
 * id 约定：raw.id 是**会话内** local_id（不全局唯一），因此拼上 conversation.id
 * 得到全局唯一 id（见 @shared/types 的注释）。
 */
export function normalizeMessage(conversation: Conversation, raw: RawMessage): ChatMessage {
  const platformMessageId =
    raw.id === undefined || raw.id === null ? `t${raw.create_time ?? 0}` : String(raw.id)
  const isSelf = raw.is_sender === true || raw.sender_side === 'me'
  const timestamp = toMillis(num(raw.create_time) ?? 0)
  const mediaPath = raw.media_info?.local_path

  return {
    id: `${conversation.id}:${platformMessageId}`,
    conversationId: conversation.id,
    accountId: conversation.accountId,
    platformMessageId,
    senderId: firstNonEmpty(
      raw.sender_wxid,
      isSelf ? 'me' : '',
      conversation.platformConversationId
    ),
    senderName: firstNonEmpty(raw.sender_name, isSelf ? '我' : '未知'),
    isSelf,
    kind: msgTypeToKind(typeof raw.msg_type === 'number' ? raw.msg_type : 0, raw.xml_parsed),
    text: messageToText(raw),
    mediaPath: mediaPath ? String(mediaPath) : undefined,
    timestamp,
    raw
  }
}
