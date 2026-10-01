/**
 * 文件与链接内容读取（enrich）
 * ------------------------------------------------------------------
 * 对应更新需求 §2「信息获取」第 1 条及其边界补充：
 *   聊天里发的文件、推文、链接的**内部信息**（标题、正文里的名称/主题/时间等）
 *   也要被读到，并参与任务抽取。
 *
 * 边界（逐字遵守）：
 *   - 文件只读常见文档类型 .docx/.pdf/.xlsx/.txt/.md；图片不做 OCR，
 *     但**保留文件引用**（Attachment 里仍有 name/path/size），供用户手动查看。
 *   - 链接只抓标题 + 正文前 500 字；抓不到就保留原始链接、不生成任务。
 *   - 只有从附件里提取到「任务关键字段」（名称/时间/材料/负责人/接头人）时，
 *     才允许据此生成任务 —— 见 hasTaskSignal()。
 *
 * 为什么全部自己实现、不加依赖：
 *   - 这是主进程里被频繁调用的小工具，引入 pdf-parse / xlsx / mammoth 之类的库
 *     会拖大安装包、增加供应链风险，而需求要的只是「够用的正文」。
 *   - .docx/.xlsx 本质是 zip：本文件用 Node 自带的 zlib.inflateRawSync 手工解析
 *     zip 中央目录（比调外部 tar 更可控：不依赖 PATH、不弹控制台窗口、跨平台一致）。
 *
 * 能力边界摘要（每个解析器详见各自函数注释）：
 *   - .txt/.md ：UTF-8 / UTF-16(BOM) / GBK 自动识别，纯文本必然成功。
 *   - .docx    ：读 word/document.xml，去掉标签取文字；**不解析表格结构、
 *                不提取图片、不解析批注/页眉页脚**。文字一定拿得到。
 *   - .xlsx    ：读 sharedStrings + 第一个工作表，按行拼接单元格文本；
 *                **不还原公式结果以外的样式、不解析图表、多工作表只取第一个**。
 *   - .pdf     ：解 FlateDecode 流后抽 Tj/TJ 文本；**扫描件、加密 PDF、
 *                使用 CID 子集字体且无 ToUnicode 的 PDF 取不到文字**，
 *                此时如实返回 failed，绝不假装成功。
 */
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { inflateRawSync, inflateSync } from 'node:zlib'
import type { Attachment, ChatMessage } from '@shared/types'
import { getAccount } from '../data/account-repo'
import { getSettings } from '../core/settings'
import { scoped } from '../core/logger'
import type { RawMessage } from '../wechat/types'

const log = scoped('enrich')

/* ==================================================================
 * 常量与通用工具
 * ================================================================== */

/** 单个文件读取上限：超过则不读（避免把内存/时间耗在大文件上） */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 单次提取文本上限：超出截断并注明（LLM 上下文有限，长文档只需摘要量级） */
export const MAX_TEXT_CHARS = 20_000
/** 链接抓取超时（需求未写，取一个对人无感的保守值） */
export const LINK_TIMEOUT_MS = 8000
/** 链接正文只取前 500 字（需求逐字规定） */
export const LINK_BODY_CHARS = 500
/** 链接下载上限：防止拉到巨大页面把内存打满 */
const MAX_LINK_BYTES = 2 * 1024 * 1024
/** 常见浏览器 UA：很多站点对空 UA 直接返回 403 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * 安全日志：测试环境或 logger 尚未就绪时，记日志绝不能把主流程带崩。
 * （extractFileText 等函数本身也不抛异常，日志同样不该成为新的异常源。）
 */
function logSafe(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  try {
    log[level](message, detail)
  } catch {
    /* 日志失败忽略 */
  }
}

/** 安全转字符串 */
function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** 安全转数字 */
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim())
  return null
}

/** 取第一个非空值 */
function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    const t = str(v)
    if (t) return t
  }
  return ''
}

/** 把任意文本压成「一行」（空白合并为单个空格） */
function oneLine(v: string): string {
  return v.replace(/\s+/g, ' ').trim()
}

/** 去掉控制字符（保留换行/制表），避免解析结果里夹带二进制噪声 */
function stripControl(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** 截断到上限并注明（正文类截断，让模型知道后面还有内容） */
function truncate(v: string, limit = MAX_TEXT_CHARS, what = '正文'): string {
  const t = v.trim()
  if (t.length <= limit) return t
  return `${t.slice(0, limit)}\n…（${what}较长，已截断，仅保留前 ${limit} 字）`
}

/** 解码 XML/HTML 实体（含数字实体） */
function decodeEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(cp: number): string {
  try {
    return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
  } catch {
    return ''
  }
}

/* ==================================================================
 * 1. 文件类型判定
 * ================================================================== */

/** 支持解析的文档扩展名（小写、不含点） */
const SUPPORTED_DOCS = new Set(['txt', 'md', 'docx', 'xlsx', 'pdf'])

/**
 * 是否是我们支持解析的文件类型。
 * 入参兼容带点/大写（如 ".PDF"），内部统一归一化。
 */
export function isSupportedDoc(ext: string): boolean {
  return SUPPORTED_DOCS.has(normalizeExt(ext))
}

/** 归一化扩展名：去掉前导点、转小写 */
function normalizeExt(ext: string): string {
  return str(ext).replace(/^\.+/, '').toLowerCase()
}

/* ==================================================================
 * 2. 纯文本编码识别（.txt / .md）
 * ================================================================== */

/**
 * 按「BOM → UTF-8 → 回退 GBK」的顺序解码。
 *
 * 为什么不能只用 UTF-8：中文 Windows 上大量 .txt 是 GBK 编码，
 * UTF-8 解出来会满屏 �，正文就废了。Node 的 TextDecoder 内置支持 'gbk'
 * （官方构建带 full-ICU），所以不需要额外依赖。
 * 判定方式：UTF-8 解码后统计替换字符 � 的占比，超过千分之五就认为不是 UTF-8。
 */
function decodeTextBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2))
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2))
  }

  const utf8 = new TextDecoder('utf-8').decode(buf)
  const bad = (utf8.match(/�/g) ?? []).length
  if (bad === 0 || bad / Math.max(1, utf8.length) < 0.005) return utf8

  // 疑似非 UTF-8：尝试 GBK（失败则仍返回 UTF-8 结果，不为编码问题报错）
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    const gbkBad = (gbk.match(/�/g) ?? []).length
    return gbkBad < bad ? gbk : utf8
  } catch {
    return utf8
  }
}

/* ==================================================================
 * 3. 无依赖 ZIP 读取（.docx / .xlsx 共用）
 * ================================================================== */

interface ZipEntry {
  name: string
  /** 压缩方法：0 = 存储，8 = deflate（其余不支持） */
  method: number
  compSize: number
  uncompSize: number
  /** 本地文件头在整包中的偏移 */
  localOffset: number
}

/**
 * 手工解析 zip 的「中央目录」。
 *
 * 取舍说明：.docx/.xlsx 就是 zip，标准做法可以调系统自带 tar（Windows 10+ 的 bsdtar
 * 支持解 zip），但那样依赖 PATH、会起子进程、跨平台行为不一。这里直接用 Node 内置
 * 的 zlib.inflateRawSync 解 deflate 数据，只支持最常见的情况，够用且行为可控。
 *
 * 不支持：ZIP64（>4GB 或超多条目，Office 文档不会出现）、加密 zip。
 */
function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip 结构（找不到中央目录）')

  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('暂不支持 ZIP64 格式的文档')
  }

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    // 条目名统一成 '/' 分隔：Office 产出的包用 '/'，但部分 Windows 打包工具
    // （如 PowerShell 的 Compress-Archive）会写成 '\'，不归一化就会找不到文件。
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/')
    entries.push({ name, method, compSize, uncompSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 从尾部向前扫 EOCD 签名（注释区最长 64KB，故只需回扫这么多） */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/** 读取 zip 中某个条目的**解压后**内容 */
function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const off = entry.localOffset
  if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error(`zip 本地文件头损坏: ${entry.name}`)
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const dataStart = off + 30 + nameLen + extraLen
  // 压缩后长度优先用中央目录里的值（本地头在流式写入时可能为 0）
  const size = entry.compSize > 0 ? entry.compSize : entry.uncompSize
  const raw = buf.subarray(dataStart, dataStart + size)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`不支持的 zip 压缩方式: ${entry.method}`)
}

/** 在 zip 中按名字找条目（大小写不敏感） */
function findEntry(entries: ZipEntry[], name: string): ZipEntry | undefined {
  const lower = name.toLowerCase()
  return entries.find((e) => e.name.toLowerCase() === lower)
}

/* ==================================================================
 * 4. .docx 解析
 * ================================================================== */

/**
 * 从 .docx 提取纯文本。
 *
 * 实现：解 zip → word/document.xml → 去标签。
 * 关键处理：`</w:p>`（段落结束）换行、`<w:br/>`（软换行）换行、`<w:tab/>` 变制表符，
 * 这样提取出来才是有段落结构的正文而不是一行糊在一起。
 *
 * 能力边界：只取 main document。**页眉页脚、脚注、批注、文本框（word/txbox）、
 * 图片里的文字都取不到**；表格单元格会被拼进同一段（单元格间用制表符）。
 */
function docxToText(buf: Buffer): string {
  const entries = readZipEntries(buf)
  const doc = findEntry(entries, 'word/document.xml')
  if (!doc) throw new Error('docx 内未找到 word/document.xml')

  const xml = readZipEntry(buf, doc).toString('utf8')
  return xmlToPlainText(xml)
}

/** WordprocessingML → 纯文本（保留段落/换行的最小实现） */
function xmlToPlainText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/?>(?:<\/w:tab>)?/g, '\t')
    .replace(/<w:br\b[^>]*\/?>(?:<\/w:br>)?/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
  const noTags = withBreaks.replace(/<[^>]*>/g, '')
  return normalizeExtracted(decodeEntities(noTags))
}

/* ==================================================================
 * 5. .xlsx 解析
 * ================================================================== */

/**
 * 从 .xlsx 提取单元格文本。
 *
 * 实现：解 zip → xl/sharedStrings.xml（共享字符串表）+ 第一个
 * xl/worksheets/sheetN.xml（单元格引用）→ 按行拼接。
 *
 * 能力边界：**只取第一个工作表**；只还原文本内容，不还原列宽/颜色/合并单元格/
 * 图表/数据透视；公式不会重算（取的是缓存值 <v>）；图片里的文字取不到。
 * 对「课表/名单/报名表」这类任务信息表，文本内容已经足够。
 */
function xlsxToText(buf: Buffer): string {
  const entries = readZipEntries(buf)

  const sharedEntry = findEntry(entries, 'xl/sharedStrings.xml')
  const sharedStrings = sharedEntry ? parseSharedStrings(readZipEntry(buf, sharedEntry).toString('utf8')) : []

  const sheet = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0]
  if (!sheet) throw new Error('xlsx 内未找到工作表（xl/worksheets/sheetN.xml）')

  return parseSheet(readZipEntry(buf, sheet).toString('utf8'), sharedStrings)
}

/** 解析共享字符串表：<si> 内的 <t> 片段拼接（富文本会被拆成多个 <t>） */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = siRe.exec(xml))) {
    let text = ''
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let tm: RegExpExecArray | null
    while ((tm = tRe.exec(m[1]))) text += decodeEntities(tm[1])
    out.push(text)
  }
  return out
}

/** 解析工作表：每行拼成制表符分隔的一行 */
function parseSheet(xml: string, shared: string[]): string {
  const lines: string[] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(xml))) {
    const cells: string[] = []
    const cRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm: RegExpExecArray | null
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] ?? ''
      const inner = cm[2] ?? ''
      const tAttr = (attrs.match(/\bt="([^"]*)"/) ?? [])[1] ?? ''
      const v = (inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) ?? [])[1]
      const t = (inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/) ?? [])[1]

      let val = ''
      if (tAttr === 's' && v !== undefined) {
        const idx = parseInt(v, 10)
        val = Number.isFinite(idx) ? shared[idx] ?? '' : ''
      } else if (tAttr === 'inlineStr') {
        val = t !== undefined ? decodeEntities(t) : ''
      } else if (v !== undefined) {
        val = decodeEntities(v)
      }
      cells.push(val.replace(/\s+/g, ' ').trim())
    }
    const line = cells.join('\t').replace(/\t+$/, '')
    if (line.trim()) lines.push(line)
  }
  return lines.join('\n')
}

/* ==================================================================
 * 6. .pdf 解析
 * ================================================================== */

/**
 * 从 .pdf 提取文本（无依赖，务实版）。
 *
 * 思路：PDF 的页面内容在 `stream ... endstream` 里，通常是 FlateDecode（zlib）压缩；
 * 解压后文本落在 `BT ... ET` 块内、由 `Tj` / `TJ` / `'` / `"` 操作符携带，
 * 字符串形式为 `(字面量)` 或 `<十六进制>`。本函数把这些字符串按出现顺序拼起来，
 * 遇到 `Td/TD/T*`（换行定位）就断行。
 *
 * 能力边界（务必知晓）：
 *   - **能**处理：文本型 PDF、FlateDecode 压缩的标准 PDF、ASCII/Latin-1 文本。
 *   - **不能**处理：扫描件（整页是图，无文字流）→ 返回 failed；
 *     加密 PDF（内容流被 RC4/AES 加密）→ 解出来是乱码，按「提取不到可读文本」判 failed；
 *     使用 CID 子集字体且无 ToUnicode CMap 的中文 PDF → 字节无法映射成 Unicode，
 *     提取出来的要么是乱码要么不足阈值，同样判 failed。
 *   这是**如实失败**，不是假装成功：拿不到文字时上层会保留链接/文件引用而不生成任务。
 */
function pdfToText(buf: Buffer): string {
  const streams = extractPdfStreams(buf)
  const chunks: string[] = []

  for (const s of streams) {
    const content = inflateBestEffort(s)
    // 只关心可能出现文本操作的流：跳过明显不含 BT 的
    const text = content.toString('latin1')
    if (!/BT[\s\S]{0,4}/.test(text) && !/\bTj\b/.test(text) && !/\bTJ\b/.test(text)) continue
    const extracted = extractTextOps(text)
    if (extracted.trim()) chunks.push(extracted)
  }

  return normalizeExtracted(chunks.join('\n'))
}

/** 找出所有 stream 的数据区（自动跳过 endstream 里的 "stream" 子串） */
function extractPdfStreams(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let idx = 0
  for (;;) {
    const s = buf.indexOf('stream', idx)
    if (s < 0) break
    // 'endstream' 里也含 'stream'，前面是 'end' 的要跳过
    if (s >= 3 && buf.toString('latin1', s - 3, s) === 'end') {
      idx = s + 6
      continue
    }
    let dataStart = s + 6
    if (buf[dataStart] === 0x0d) dataStart++
    if (buf[dataStart] === 0x0a) dataStart++
    const e = buf.indexOf('endstream', dataStart)
    if (e < 0) break
    let dataEnd = e
    if (dataEnd > dataStart && buf[dataEnd - 1] === 0x0a) dataEnd--
    if (dataEnd > dataStart && buf[dataEnd - 1] === 0x0d) dataEnd--
    out.push(buf.subarray(dataStart, dataEnd))
    idx = e + 9
  }
  return out
}

/** 先按 zlib 解，失败再按 raw deflate 解，都失败就当未压缩原样返回 */
function inflateBestEffort(data: Buffer): Buffer {
  if (data.length === 0) return data
  try {
    return inflateSync(data)
  } catch {
    /* 继续尝试 raw deflate */
  }
  try {
    return inflateRawSync(data)
  } catch {
    return data
  }
}

/**
 * 从内容流里抽取文本操作符的字符串。
 * 用单个正则按出现顺序扫描字符串与「换行定位操作符」，保证文本顺序不乱。
 */
function extractTextOps(content: string): string {
  const tokenRe = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]+>|T\*|Td|TD/g
  let out = ''
  let pendingBreak = false
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(content))) {
    const tok = m[0]
    if (tok[0] === '(') {
      if (pendingBreak && out && !out.endsWith('\n')) out += '\n'
      pendingBreak = false
      out += pdfLiteralToString(tok)
    } else if (tok[0] === '<') {
      if (pendingBreak && out && !out.endsWith('\n')) out += '\n'
      pendingBreak = false
      out += pdfHexToString(tok)
    } else {
      // Td / TD / T* —— 下一次出文字前换行
      pendingBreak = true
    }
  }
  return out
}

/** `(字面量)` → 文本（处理转义与八进制） */
function pdfLiteralToString(raw: string): string {
  const s = raw.slice(1, -1)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = s[++i]
    switch (n) {
      case 'n':
        out += '\n'
        break
      case 'r':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case 'b':
      case 'f':
        break
      case '(':
        out += '('
        break
      case ')':
        out += ')'
        break
      case '\\':
        out += '\\'
        break
      case '\r':
        if (s[i + 1] === '\n') i++
        break
      case '\n':
        break
      default:
        if (n >= '0' && n <= '7') {
          let oct = n
          while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i]
          out += String.fromCharCode(parseInt(oct, 8))
        } else {
          out += n
        }
    }
  }
  return out
}

/** `<十六进制>` → 文本；优先按 UTF-16BE BOM 解，否则按 Latin-1 尽力解 */
function pdfHexToString(raw: string): string {
  const clean = raw.slice(1, -1).replace(/[^0-9A-Fa-f]/g, '')
  const bytes: number[] = []
  for (let i = 0; i + 1 < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(Uint8Array.from(bytes.slice(2)))
    } catch {
      /* 落到 Latin-1 */
    }
  }
  return Buffer.from(bytes).toString('latin1')
}

/* ==================================================================
 * 7. 统一的文本清洗
 * ================================================================== */

/** 去控制字符、合并多余空行与行内空白 */
function normalizeExtracted(v: string): string {
  return stripControl(v)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ==================================================================
 * 8. extractFileText —— 对外主入口
 * ================================================================== */

/**
 * 从本地文件提取正文。
 *
 * 约定：
 *   - 不支持的类型返回 { status: 'skipped' }（不是错误，是需求规定的范围之外）
 *   - 文件不存在 / 超过大小上限 / 解析失败返回 { status: 'failed', reason: 中文 }
 *   - **绝不抛异常**（调用方按状态处理即可）
 *
 * @param filePath 文件绝对路径
 * @param ext      扩展名（带不带点都行）；为空时按 filePath 推断
 */
export async function extractFileText(
  filePath: string,
  ext: string
): Promise<{ status: Attachment['status']; text?: string; reason?: string }> {
  const started = Date.now()
  const normalized = normalizeExt(ext) || normalizeExt(extname(filePath))
  let fileSize = 0
  const done = (status: Attachment['status'], extra: { text?: string; reason?: string } = {}) => {
    // 隐私：日志只记长度与状态，绝不输出正文内容
    logSafe(status === 'ok' ? 'info' : 'warn', '文件内容提取结束', {
      文件: basename(filePath || ''),
      类型: normalized || '未知',
      大小字节: fileSize || undefined,
      耗时ms: Date.now() - started,
      状态: status,
      正文字符数: extra.text ? extra.text.length : 0,
      原因: extra.reason
    })
    return { status, ...extra }
  }

  if (!isSupportedDoc(normalized)) {
    return done('skipped', { reason: `暂不支持解析 .${normalized || '未知'} 类型的文件` })
  }
  if (!filePath) {
    return done('failed', { reason: '文件路径为空（可能已被清理）' })
  }

  let size = 0
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return done('failed', { reason: '目标不是文件' })
    size = st.size
    fileSize = size
  } catch {
    return done('failed', { reason: '本地文件不存在或已被清理' })
  }
  if (size > MAX_FILE_BYTES) {
    return done('failed', {
      reason: `文件过大（${(size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限）`
    })
  }

  try {
    const buf = await readFile(filePath)
    let text = ''
    switch (normalized) {
      case 'txt':
      case 'md':
        text = decodeTextBuffer(buf)
        break
      case 'docx':
        text = docxToText(buf)
        break
      case 'xlsx':
        text = xlsxToText(buf)
        break
      case 'pdf':
        text = pdfToText(buf)
        break
      default:
        return done('skipped', { reason: `暂不支持解析 .${normalized} 类型的文件` })
    }

    text = normalizeExtracted(text)
    if (!text.trim()) {
      return done('failed', { reason: `${normalized.toUpperCase()} 中没有提取到可读的文字内容` })
    }
    return done('ok', { text: truncate(text) })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return done('failed', { reason: `解析失败：${reason}` })
  }
}

/* ==================================================================
 * 9. fetchLinkText —— 链接抓取
 * ================================================================== */

/**
 * 抓取网页「标题 + 正文前 500 字」。
 *
 * 只用全局 fetch + AbortController（Node 20 内置，无依赖），超时 8 秒。
 * 失败（超时/非 2xx/非 HTML/网络错误）一律返回 failed + 中文原因，**不抛异常**。
 * 抓不到时上层会「保留原始链接、不生成任务」，正是需求要的行为。
 */
export async function fetchLinkText(
  url: string
): Promise<{ status: Attachment['status']; title?: string; text?: string; reason?: string }> {
  const started = Date.now()
  const done = (
    status: Attachment['status'],
    extra: { title?: string; text?: string; reason?: string } = {}
  ) => {
    logSafe(status === 'ok' ? 'info' : 'warn', '链接内容抓取结束', {
      链接: url,
      耗时ms: Date.now() - started,
      状态: status,
      标题字符数: extra.title ? extra.title.length : 0,
      正文字符数: extra.text ? extra.text.length : 0,
      原因: extra.reason
    })
    return { status, ...extra }
  }

  const target = str(url)
  if (!/^https?:\/\//i.test(target)) {
    return done('failed', { reason: '链接格式不合法（仅支持 http/https）' })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS)
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })

    if (!res.ok) return done('failed', { reason: `网页返回状态码 ${res.status}` })

    const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
    if (ctype && !/text\/|application\/xhtml|application\/xml/.test(ctype)) {
      return done('failed', { reason: `网页内容类型无法解析（${ctype.split(';')[0]}）` })
    }

    const raw = (await res.text()).slice(0, MAX_LINK_BYTES)
    const title = extractTitle(raw)
    const body = extractBody(raw, LINK_BODY_CHARS)

    if (!title && !body) {
      return done('failed', { reason: '页面没有可提取的文字内容' })
    }
    // 标题为空时退化为取正文开头一小段，方便界面识别这是哪条链接
    return done('ok', { title: title || undefined, text: body || undefined })
  } catch (e) {
    const isAbort = e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))
    return done('failed', {
      reason: isAbort ? `抓取超时（${LINK_TIMEOUT_MS / 1000} 秒）` : `抓取失败：${e instanceof Error ? e.message : String(e)}`
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 取 <title> 文本 */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? oneLine(decodeEntities(m[1])) : ''
}

/**
 * 取正文前 N 字。
 * 做法：先剔除 script/style/noscript/注释/head，再去标签、解实体、压空白。
 * 这是「够用」的正文抽取——不做 Readability 那种打分，需求只要前 500 字判断有无任务信息。
 */
function extractBody(html: string, limit: number): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
  const text = oneLine(decodeEntities(cleaned))
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/* ==================================================================
 * 10. collectAttachments —— 从一条消息里找附件
 * ================================================================== */

/**
 * 从一条消息里找出所有附件（文件 + 链接），读取内容，返回 Attachment[]。
 *
 * 只处理 kind 为 'file' | 'link' 的消息；其余返回 undefined（**不产生空数组**，
 * 这样 ChatMessage.attachments 只在真读过内容时才存在，与类型注释一致）。
 */
export async function collectAttachments(msg: ChatMessage): Promise<Attachment[] | undefined> {
  if (msg.kind !== 'file' && msg.kind !== 'link') return undefined

  const raw: RawMessage = msg.raw && typeof msg.raw === 'object' ? (msg.raw as RawMessage) : {}
  const xml: Record<string, unknown> =
    raw.xml_parsed && typeof raw.xml_parsed === 'object' ? (raw.xml_parsed as Record<string, unknown>) : {}
  const media = raw.media_info ?? null
  const atts: Attachment[] = []

  if (msg.kind === 'file') {
    const name = firstNonEmpty(
      xml.title,
      media?.file_name,
      msg.mediaPath ? basename(msg.mediaPath) : '',
      '未命名文件'
    )
    const rel = firstNonEmpty(msg.mediaPath, xml.file_path)
    const abs = resolveMediaPath(msg.accountId, rel)
    const ext = normalizeExt(firstNonEmpty(xml.ext, extname(abs || name)))
    const size = num(xml.size) ?? num(media?.file_size) ?? undefined

    const att: Attachment = {
      type: 'file',
      name,
      path: abs || undefined,
      ext: ext || undefined,
      size: size ?? undefined,
      status: 'pending'
    }

    if (!abs || !existsSync(abs)) {
      att.status = 'failed'
      att.reason = '本地文件不存在或已被清理（保留引用供手动查看）'
      logSafe('warn', '附件文件缺失，未读取内容', { 文件: name, 相对路径: rel || undefined })
    } else if (!isSupportedDoc(ext)) {
      att.status = 'skipped'
      att.reason = `暂不支持解析 .${ext || '未知'} 类型的文件（保留引用供手动查看）`
      logSafe('info', '附件类型不在解析范围内，跳过', { 文件: name, 类型: ext })
    } else {
      const r = await extractFileText(abs, ext)
      att.status = r.status
      att.text = r.text
      att.reason = r.reason
    }
    atts.push(att)
  } else {
    // link：优先取 xml.url；个别消息 url 缺失时，从正文里再找一次
    const url = firstNonEmpty(xml.url, extractFirstUrl(msg.text))
    if (url) {
      const att: Attachment = {
        type: 'link',
        name: firstNonEmpty(xml.title, xml.des, url),
        url,
        status: 'pending'
      }
      const r = await fetchLinkText(url)
      att.status = r.status
      // 拿到网页 <title> 时用它作为更准确的展示名
      if (r.title) att.name = r.title
      att.text = r.text
      att.reason = r.reason
      atts.push(att)
    }
  }

  if (atts.length === 0) return undefined
  logSafe('info', '消息附件处理完成', {
    消息: msg.id,
    附件数: atts.length,
    明细: atts.map((a) => ({ 类型: a.type, 名称: a.name, 状态: a.status }))
  })
  return atts
}

/** 把消息里的文件相对路径解析成绝对路径（可能为空） */
function resolveMediaPath(accountId: string, rel: string): string {
  if (!rel) return ''
  if (isAbsolute(rel)) return rel

  const candidates: string[] = []

  // 账号的 db_storage 目录：微信的媒体路径相对账号根目录（db_storage 的上一级），
  // 所以「上一级 + rel」优先，「db_storage + rel」兜底。
  try {
    const acc = getAccount(accountId)
    if (acc?.dbStorageDir) {
      candidates.push(join(dirname(acc.dbStorageDir), rel))
      candidates.push(join(acc.dbStorageDir, rel))
    }
  } catch {
    /* 数据库/保险库未就绪时忽略，继续用设置里的目录兜底 */
  }

  try {
    const cfg = getSettings().dbStorageDir
    if (cfg) {
      candidates.push(join(dirname(cfg), rel))
      candidates.push(join(cfg, rel))
    }
  } catch {
    /* 设置不可读时忽略 */
  }

  candidates.push(resolve(rel))

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* 单个候选不可访问则跳过 */
    }
  }
  // 都不存在时返回首选候选（让上层以「文件不存在」如实失败，并保留路径供排查）
  return candidates[0] ?? rel
}

/** 从文本里抓第一个 http(s) 链接 */
function extractFirstUrl(text: string): string {
  const m = str(text).match(/https?:\/\/[^\s"'<>）)】\]]+/i)
  return m ? m[0] : ''
}

/* ==================================================================
 * 11. hasTaskSignal —— 决定要不要据附件生成任务
 * ================================================================== */

/**
 * 判断附件正文里是否含有「任务关键字段」。
 *
 * 需求边界逐字：名称/时间/材料/负责人/接头人 **至少命中一个**才算，
 * 否则「只在原文中保留该文件或链接的引用，不单独成任务」。
 * 这里用关键词 + 时间形态的规则判断，宁可稍宽（后续仍由 LLM/去重把关），
 * 也不要漏掉真任务。
 */
export function hasTaskSignal(text: string): boolean {
  const t = oneLine(text)
  if (!t) return false

  const patterns: RegExp[] = [
    // 时间：各种日期/时刻写法，或「截止/报名/开始/结束」等时间语境词
    /\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}/,
    /\d{1,2}\s*月\s*\d{1,2}\s*日/,
    /\d{1,2}\s*[:：]\s*\d{2}/,
    /(截止|截至|报名|开始|结束|会议时间|活动时间|提交时间|有效期|截止日期|deadline)/,
    // 名称/主题
    /(名称|标题|主题|题目|通知|公告|活动|比赛|竞赛|大赛|培训|讲座|会议|答辩|报名|招募|征集|招聘)/,
    // 材料
    /(材料|表格|表单|文档|附件|文件|照片|证件|证明|申请|报名表|提交|填写|上传|材料清单)/,
    // 负责人
    /(负责人|主办|承办|组织单位|主办单位|承办单位|组织者|班主任|辅导员|老师)/,
    // 接头人
    /(接头人|联系人|联系|咨询|报名联系|找[^\s，。]{1,6}|加微信|微信[:：]|电话[:：]|tel)/i
  ]

  return patterns.some((re) => re.test(t))
}

/* ==================================================================
 * 12. attachmentsToContext —— 拼给 LLM 的附件上下文
 * ================================================================== */

/**
 * 把附件正文拼成给 LLM 的补充上下文（供 prompt.ts 的 buildTranscript 调用）。
 *
 * 只输出 status==='ok' 且有 text 的附件——失败/跳过的附件不喂给模型，
 * 避免模型拿「没读到内容」当依据编造任务。
 * 每条压成一行，格式与 transcript 的缩进风格一致：
 *   `  └─ 附件《报名表.docx》内容摘要: ...`
 */
export function attachmentsToContext(atts: Attachment[]): string {
  const lines: string[] = []
  for (const a of atts) {
    if (a.status !== 'ok') continue
    const body = oneLine(a.text ?? '')
    if (!body) continue
    const label = a.type === 'link' ? '链接' : '附件'
    lines.push(`  └─ ${label}《${a.name}》内容摘要: ${body}`)
  }
  return lines.join('\n')
}
