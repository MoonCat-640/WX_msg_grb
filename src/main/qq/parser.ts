/**
 * QQ 消息 BLOB 解析器
 * ==================================================================
 * 本文件是参考实现 `reference/QQFlow-main/src-tauri/src/message_parser.rs`
 * （约 400 行 Rust）的**逐行精确移植**。所有判定分支、阈值、字节级逻辑
 * 均按原实现照搬，不要凭直觉"优化"。
 *
 * 为什么这么麻烦：
 *   QQ NT 把一条消息的全部信息（正文、结构化 JSON、媒体文件名、系统提示…）
 *   序列化进一个 Protobuf-ish 的二进制 BLOB（列 40800）。没有公开 schema，
 *   只能用"文本纯度"启发式把真正的聊天文本从 varint 噪声里挑出来。
 *   Rust 版注释里说得很清楚：Protobuf 的长度标记经常恰好解码成 CJK 扩展区的
 *   "生僻字"，所以 `is_common_han` 只认常用汉字区 0x4E00..=0x9FA5。
 *
 * 移植时最容易踩的坑（务必保持）：
 *   1. Rust 的 `str::len()` 是**字节长度**，`chars().count()` 才是字符数。
 *      代码里任何 `text.len() >= 2/3/4` 都必须用字节长度（Buffer.byteLength）。
 *   2. `char::is_control()` 是 Unicode Cc（含 0x7F..0x9F），不能只判 <0x20。
 *   3. `std::str::from_utf8` 的成败必须用**严格** UTF-8 解码判定，不能用
 *      `Buffer.toString()`（它会用 � 吞掉非法字节，导致把噪声当文本）。
 *   4. `collect_text_run` / `decode_utf8_char` 的字节级分支要一模一样。
 */
import type { QqParsedMessage, QqMessageType } from './types'

/* ==================================================================
 * UTF-8 严格解码小工具
 * ================================================================== */

/** 严格 UTF-8 解码器：非法字节返回 null（等价 Rust 的 str::from_utf8 失败） */
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes)
  } catch {
    return null
  }
}

/** 字符（码点）数量，等价 Rust 的 chars().count() */
function codePointCount(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/** 字节长度，等价 Rust 的 str::len() */
function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/* ==================================================================
 * 文本纯净度过滤
 * ================================================================== */

/**
 * 是否常用汉字（CJK 统一表意文字基本区）。
 * 刻意**不包含**扩展区（0x3400-0x4DBF、0x20000-...），因为 Protobuf 的
 * varint 长度标记经常解码到那些区，产出"生僻字"噪声。
 */
export function isCommonHan(cp: number): boolean {
  return cp >= 0x4e00 && cp <= 0x9fa5
}

/** ASCII 字母数字（Rust char::is_ascii_alphanumeric） */
function isAsciiAlphanumeric(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
}

/** ASCII 标点（Rust char::is_ascii_punctuation） */
const ASCII_PUNCT = new Set(
  [...`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`].map((c) => c.charCodeAt(0))
)
function isAsciiPunctuation(cp: number): boolean {
  return ASCII_PUNCT.has(cp)
}

/** Unicode Cc 控制字符（Rust char::is_control） */
function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)
}

/**
 * 判断抽取出的文本像不像真实聊天内容，而不是恰好解码成 Unicode 的 Protobuf 二进制。
 * 逐字对应 Rust 的 is_valid_chat_text：
 *   - 字符数 < 2（单字）几乎必然是 varint 噪声 → 直接判否
 *   - common = 常用汉字 / ASCII 字母数字 / ASCII 标点 / 空格
 *   - suspect = 控制字符
 *   - 其余（emoji、符号等非 ASCII 可打印）既不 common 也不 suspect，不计入比例
 *   - 要求 common / (common + suspect) > 0.60
 */
export function isValidChatText(text: string): boolean {
  let charCount = 0
  let common = 0
  let suspect = 0

  for (const ch of text) {
    charCount++
    const cp = ch.codePointAt(0) ?? 0
    if (isCommonHan(cp) || isAsciiAlphanumeric(cp) || isAsciiPunctuation(cp) || cp === 0x20) {
      common++
    } else if (isControl(cp)) {
      suspect++
    }
    // 其余非 ASCII 可打印字符不计入任何一类
  }

  if (charCount < 2) return false

  const total = common + suspect
  if (total === 0) return false

  return common / total > 0.6
}

/* ==================================================================
 * UTF-8 字节级工具
 * ================================================================== */

/** 是否为 UTF-8 续字节 0x80..=0xBF */
function isContinuation(b: number): boolean {
  return b >= 0x80 && b <= 0xbf
}

/**
 * 从 `i` 开始收集一段连续的 UTF-8 文本 run。
 * 逐字对应 Rust 的 collect_text_run：
 *   - 按首字节判断字符长度（4/3/2/1），越界则先按可行长度切
 *   - 用严格 UTF-8 解码该切片，失败即停
 *   - 可打印 ASCII / \n / \r 视为长度 1 的字符
 *   - 其余字节（含续字节）直接停
 * 返回 trim 后的字符串与新的扫描位置。
 */
export function collectTextRun(blob: Uint8Array, start: number): { text: string; next: number } {
  let i = start
  const n = blob.length
  let run = ''

  while (i < n) {
    const b = blob[i]
    let cl: number
    if (b >= 0xf0 && i + 4 <= n) cl = 4
    else if (b >= 0xe0 && i + 3 <= n) cl = 3
    else if (b >= 0xc0 && i + 2 <= n) cl = 2
    else if ((b >= 32 && b <= 126) || b === 0x0a || b === 0x0d) cl = 1
    else break

    const decoded = tryDecodeUtf8(blob.subarray(i, i + cl))
    if (decoded === null) break

    run += decoded
    i += cl
  }

  return { text: run.trim(), next: i }
}

/**
 * 从 `i` 解码一个 UTF-8 字符，返回码点与字节长度；不合法返回 null。
 * 逐字对应 Rust 的 decode_utf8_char（注意：纯 ASCII 也会返回 null，
 * 因为它只处理 0xC0 及以上的多字节起始字节——调用方的分支依赖这一点）。
 */
export function decodeUtf8Char(blob: Uint8Array, i: number): { cp: number; len: number } | null {
  const b = blob[i]
  const n = blob.length

  if (b >= 0xf0 && i + 4 <= n && isContinuation(blob[i + 1]) && isContinuation(blob[i + 2]) && isContinuation(blob[i + 3])) {
    const cp =
      ((b & 0x07) << 18) |
      ((blob[i + 1] & 0x3f) << 12) |
      ((blob[i + 2] & 0x3f) << 6) |
      (blob[i + 3] & 0x3f)
    return { cp, len: 4 }
  }
  if (b >= 0xe0 && i + 3 <= n && isContinuation(blob[i + 1]) && isContinuation(blob[i + 2])) {
    const cp = ((b & 0x0f) << 12) | ((blob[i + 1] & 0x3f) << 6) | (blob[i + 2] & 0x3f)
    return { cp, len: 3 }
  }
  if (b >= 0xc0 && i + 2 <= n && isContinuation(blob[i + 1])) {
    const cp = ((b & 0x1f) << 6) | (blob[i + 1] & 0x3f)
    return { cp, len: 2 }
  }
  return null
}

/* ==================================================================
 * 主入口
 * ================================================================== */

/**
 * 解析一条 QQ 消息 BLOB（列 40800），返回 (类型, 可读文本)。
 * 逐字对应 Rust 的 extract_text。
 */
export function extractText(blob: Uint8Array): QqParsedMessage {
  if (blob.length === 0) {
    return { msgType: 'text', content: '[空]' }
  }

  // 快路径：>64KB 的 BLOB 几乎必然是媒体，不做逐字节扫描，只查媒体签名
  if (blob.length > 65536) {
    return classifyLargeBlob(blob)
  }

  // 先尝试整块当 UTF-8 文本（处理纯文本消息）
  const whole = tryDecodeUtf8(blob)
  if (whole !== null) {
    const trimmed = whole.trim()
    if (trimmed.length > 0) {
      // 结构化消息（小程序 / 分享 / 卡片）
      const json = extractJsonBlob(trimmed)
      if (json !== null) return { msgType: 'miniapp', content: json }

      if (isValidChatText(trimmed)) {
        const content = extractPrompt(trimmed)
        if (content.startsWith('你猜猜撤回了什么')) {
          return { msgType: 'recall', content: '[撤回了一条消息]' }
        }
        if (isSystemText(content)) {
          return { msgType: 'system', content }
        }
        return { msgType: 'text', content }
      }
    }
  }

  const n = blob.length
  // 操作预算：防止病态输入把扫描拖死（saturating_mul(50)）
  const budget = n * 50

  // 扫描「以汉字开头」的文本段（原始做法）
  const texts: string[] = []
  {
    let i = 0
    let ops = 0
    while (i < n) {
      ops++
      if (ops > budget) return classifyByAscii(blob)
      const dec = decodeUtf8Char(blob, i)
      if (dec !== null) {
        if (isCommonHan(dec.cp)) {
          const run = collectTextRun(blob, i)
          if (byteLen(run.text) >= 2 && isValidChatText(run.text)) {
            texts.push(run.text)
          }
          i = run.next
          continue
        }
        i += dec.len
      } else {
        i += 1
      }
    }
  }

  if (texts.length > 0) {
    let content = texts.join(' ')
    content = trimJsonSuffix(content)
    content = extractPrompt(content)
    const json = extractJsonBlob(content)
    if (json !== null) return { msgType: 'miniapp', content: json }
    if (content.startsWith('你猜猜撤回了什么')) {
      return { msgType: 'recall', content: '[撤回了一条消息]' }
    }
    if (isSystemText(content)) {
      return { msgType: 'system', content }
    }
    return { msgType: 'text', content }
  }

  // 扫描「任意 UTF-8 文本段」（不仅限汉字开头）——处理以 ASCII 或混合内容开头的消息
  {
    let i = 0
    let ops = 0
    while (i < n) {
      ops++
      if (ops > budget) return classifyByAscii(blob)
      const dec = decodeUtf8Char(blob, i)
      if (dec !== null) {
        if (dec.len > 1 || (blob[i] >= 32 && blob[i] <= 126)) {
          const run = collectTextRun(blob, i)
          if (byteLen(run.text) >= 3) {
            const json = extractJsonBlob(run.text)
            if (json !== null) return { msgType: 'miniapp', content: json }
            if (isValidChatText(run.text)) {
              const content = extractPrompt(run.text)
              return { msgType: 'text', content }
            }
          }
          i = run.next
          continue
        }
        i += dec.len
      } else {
        i += 1
      }
    }
  }

  return classifyByAscii(blob)
}

/** 系统消息关键词（Rust 里重复了两次，抽成一个函数便于对照） */
function isSystemText(content: string): boolean {
  return (
    content.includes('戳了搓') ||
    content.includes('拍了拍') ||
    content.includes('撤回了一条') ||
    content.includes('修改群名')
  )
}

/** 大 BLOB（媒体）的快速分类，对应 classify_large_blob */
function classifyLargeBlob(blob: Uint8Array): QqParsedMessage {
  const sample = blob.subarray(0, Math.min(blob.length, 8192))
  const ascii = printableAscii(sample)

  if (ascii.includes('.jpg') || ascii.includes('.png') || ascii.includes('.gif') || ascii.includes('gchatpic')) {
    return { msgType: 'image', content: '[图片]' }
  }
  if (ascii.includes('.amr') || ascii.includes('.silk') || ascii.includes('.ptt')) {
    return { msgType: 'voice', content: '[语音]' }
  }
  if (ascii.toLowerCase().includes('shortvideo') || ascii.includes('.mp4')) {
    return { msgType: 'video', content: '[短视频]' }
  }
  return { msgType: 'other', content: '[其他]' }
}

/** 按 ASCII 内容分类，对应 classify_by_ascii */
function classifyByAscii(blob: Uint8Array): QqParsedMessage {
  const asciiContent = printableAscii(blob)

  if (
    asciiContent.includes('.jpg') ||
    asciiContent.includes('.png') ||
    asciiContent.includes('.gif') ||
    asciiContent.includes('gchatpic')
  ) {
    return { msgType: 'image', content: '[图片]' }
  }
  if (asciiContent.includes('.amr') || asciiContent.includes('.silk') || asciiContent.includes('.ptt')) {
    return { msgType: 'voice', content: '[语音]' }
  }
  if (asciiContent.toLowerCase().includes('shortvideo') || asciiContent.includes('.mp4')) {
    return { msgType: 'video', content: '[短视频]' }
  }

  // 再尝试整块当文本读一遍
  const whole = tryDecodeUtf8(blob)
  if (whole !== null) {
    const text = whole.trim()
    if (text.length > 0 && isValidChatText(text)) {
      return { msgType: 'text', content: extractPrompt(text) }
    }
  }

  // 小 BLOB 再努力找一找：扫描最长的一段连续可打印 ASCII（>=4 字节）
  if (blob.length < 500) {
    let bestRun = ''
    let currentRun = ''
    for (const b of blob) {
      if (b >= 32 && b <= 126) {
        currentRun += String.fromCharCode(b)
      } else {
        if (currentRun.length > bestRun.length) bestRun = currentRun
        currentRun = ''
      }
    }
    if (currentRun.length > bestRun.length) bestRun = currentRun
    if (bestRun.length >= 4 && isValidChatText(bestRun)) {
      return { msgType: 'text', content: bestRun }
    }
  }

  return { msgType: 'other', content: '[其他]' }
}

/** 把 BLOB 里所有可打印 ASCII（32..=126）拼成字符串 */
function printableAscii(blob: Uint8Array): string {
  let out = ''
  for (const b of blob) {
    if (b >= 32 && b <= 126) out += String.fromCharCode(b)
  }
  return out
}

/* ==================================================================
 * 文本后处理
 * ================================================================== */

/**
 * 从 QQ 结构化广告消息里提取人类可读的 `prompt` 字段。
 * 输入示例：`...发现异星生命！","meta":{...},"prompt":"发现异星生命！集结领取预约礼包",...`
 * 输出：`发现异星生命！集结领取预约礼包`
 * 逐字对应 Rust 的 extract_prompt。
 */
export function extractPrompt(text: string): string {
  const marker = '"prompt":"'
  const pos = text.indexOf(marker)
  if (pos >= 0) {
    const rest = text.slice(pos + marker.length)
    let inEscape = false
    let end = -1
    // 逐 UTF-16 单元扫描；只会在 ASCII 的 \\ 与 " 处切分，不会切断代理对
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]
      if (inEscape) {
        inEscape = false
        continue
      }
      if (c === '\\') {
        inEscape = true
        continue
      }
      if (c === '"') {
        end = i
        break
      }
    }
    if (end >= 0) {
      const prompt = rest
        .slice(0, end)
        .split('\\"')
        .join('"')
        .split('\\n')
        .join('\n')
        .split('\\t')
        .join('\t')
      if (prompt.length > 0) return prompt
    }
  }
  return text
}

/**
 * 提取单个 JSON 字符串字段值（处理 \" 转义）。
 * 逐字对应 Rust 的 extract_json_field。
 */
export function extractJsonField(text: string, fieldName: string): string | null {
  const search = `"${fieldName}":"`
  const pos = text.indexOf(search)
  if (pos < 0) return null
  const afterKey = text.slice(pos + search.length)

  let result = ''
  let inEscape = false
  for (const c of afterKey) {
    if (inEscape) {
      result += c
      inEscape = false
      continue
    }
    if (c === '\\') {
      inEscape = true
      continue
    }
    if (c === '"') break
    result += c
  }

  const cleaned = result
    .split('\\/')
    .join('/')
    .split('\\n')
    .join(' ')
    .split('\\t')
    .join(' ')
    .trim()
  return cleaned.length === 0 ? null : cleaned
}

/**
 * 判断文本是否像 JSON 结构化数据（app 分享 / 小程序 / 卡片）。
 * 逐字对应 Rust 的 is_json_blob：字符数 >= 50，JSON 语法字符占比 > 0.12。
 */
export function isJsonBlob(text: string): boolean {
  const total = codePointCount(text)
  if (total < 50) return false
  let jsonChars = 0
  for (const c of text) {
    if (c === '{' || c === '}' || c === '"' || c === ':' || c === '[' || c === ']') jsonChars++
  }
  return jsonChars / total > 0.12
}

/**
 * 尝试从 JSON 结构化消息里抽取人类可读内容；不是 JSON 结构返回 null。
 * 逐字对应 Rust 的 extract_json_blob：依次取 prompt / desc / title / nick。
 */
export function extractJsonBlob(text: string): string | null {
  if (!isJsonBlob(text)) return null

  const parts: string[] = []

  // prompt 字段（分享/小程序最常见）
  const p = extractJsonField(text, 'prompt')
  if (p !== null) {
    // 去掉 QQ 加的 [...] 前缀：[小程序]、[分享]、[视频] 等
    let start = 0
    const stripChars = '[] \t\r\n小程序分享视频文件链接图片'
    while (start < p.length && stripChars.includes(p[start])) start++
    const cleaned = p.slice(start)
    if (cleaned.length > 0) parts.push(cleaned)
  }

  const d = extractJsonField(text, 'desc')
  if (d !== null && !parts.includes(d)) parts.push(d)

  const t = extractJsonField(text, 'title')
  if (t !== null && !parts.includes(t)) parts.push(t)

  const n = extractJsonField(text, 'nick')
  if (n !== null) {
    const nickText = `来自: ${n}`
    if (!parts.some((part) => part.includes(nickText))) parts.push(nickText)
  }

  if (parts.length === 0) return '[小程序/分享]'
  return parts.join(' | ')
}

/**
 * 去掉文本尾部紧跟的 JSON 元数据。
 * 逐字对应 Rust 的 trim_json_suffix。
 */
export function trimJsonSuffix(text: string): string {
  let pos = text.indexOf(',"appID"')
  if (pos >= 0) return text.slice(0, pos)
  pos = text.indexOf(',"appid"')
  if (pos >= 0) return text.slice(0, pos)

  for (const pattern of ['","appID"', '","appid"', '","meta"', '","config"']) {
    const p = text.indexOf(pattern)
    if (p >= 0) {
      const trimmed = text.slice(0, p + 1) // 含收尾引号
      if (isValidChatText(trimmed)) return trimmed
    }
  }
  return text
}

/** QQ 类型 → 本项目 MessageKind（在 reader 里用，集中放这里便于对照） */
export function qqTypeToMessageKind(t: QqMessageType): string {
  switch (t) {
    case 'text':
      return 'text'
    case 'image':
      return 'image'
    case 'voice':
      return 'voice'
    case 'video':
      return 'video'
    case 'system':
      return 'system'
    case 'recall':
      return 'system'
    case 'miniapp':
      return 'mini-program'
    default:
      return 'other'
  }
}
