/**
 * QQ 数据库 SQLCipher 解密
 * ==================================================================
 * ⚠️ ⚠️ ⚠️  未用真实 QQ 数据库验证过的部分，请看这里  ⚠️ ⚠️ ⚠️
 * ------------------------------------------------------------------
 * 本文件按「规格」实现了 QQ 的 SQLCipher 4 解密，但没有真实库可供端到端验证
 * （开发机上没有登录过 QQ、也没有 QQFlow 生成的密钥）。经评估：
 *
 *   已按规格实现、**可以确信**的部分：
 *     - 文件前 1024 字节是文件头，其后才是密文（QQFlow export_chat.rs::get_cached_db
 *       里 src.seek(SeekFrom::Start(1024)) 为证）
 *     - 页面大小 4096；每页尾部是预留区 [密文…][IV 16B][HMAC]
 *     - AES key = PBKDF2-HMAC-SHA512(口令, salt, 4000, 32)；salt = 第 1 页前 16 字节
 *       （SQLCipher 4 的密钥派生：第一段 KDF 输出的前 key_sz 字节即加密密钥，
 *        与 HMAC 算法无关——因此**解密本身不依赖 HMAC 算法**）
 *     - 第 1 页：明文 = "SQLite format 3\0"(16B, 常量) + AES-CBC(密文) + 预留区清零
 *     - 第 n>1 页：明文 = AES-CBC(密文) + 预留区清零
 *       （预留区布局与微信 SQLCipher §C.9 同构，WX_message/docs/reference/
 *        wechat-exp-integration-contract.md 有逐字描述，可交叉印证）
 *
 *   无法确信、因此做成「**多候选自校验**」的部分：
 *     - 预留区大小取决于 HMAC 算法（IV 16B + HMAC），而 HMAC 用 SHA1(20B) 还是
 *       SHA512(64B) 会导致密文区长度不同（QQFlow 先试 HMAC_SHA1、失败回退
 *       HMAC_SHA512）。这里不写死，而是**逐个候选布局试解第 1 页，用「解出来的
 *       页头是否像合法 SQLite 页」来自证**（见 validatePage1）。这与任务的
 *       「自校验」要求一致，只是判据比"是否以 SQLite format 3\0 开头"更严格
 *       ——因为那 16 字节在 SQLCipher 里是常量，永远匹配，无法证明密钥正确。
 *     - HMAC 本身（防篡改）未参与判据（HMAC key 的派生在 SQLCipher 4 里是一段
 *       固定 salt 的二次 KDF，细节未 100% 复刻）。我们只做「能读」的解密，
 *       不做认证——读取本地自己的库没有安全风险。
 *
 *   如果两条路都失败，会抛出中文错误，明确引导用户改走兜底方案：
 *     「用 QQFlow 导出 TXT，再用本软件读取」。
 * ==================================================================
 *
 * 降级路径（task 要求写清楚）：
 *   A. 原文件本身就是明文 SQLite（开头就是 SQLite format 3\0，有些工具解密后
 *      直接覆盖原文件）→ 直接使用。
 *   B. %TEMP%\qqflow_cache\ 下的副本 → 已核实它**仍然是加密的**（QQFlow 只去掉
 *      1024 头后原样拷贝），所以单独用没用；但若用户/别的工具往里放了明文库，
 *      我们能识别并复用。
 *   C. 都不行 → 抛中文错误，提示改用「QQFlow 导出 TXT 再读取」。
 */
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errors } from '@main/core/errors'
import { scoped } from '@main/core/logger'
import { qqflowCacheDir } from './locator'
import type { QqDecryptProgress, QqDecryptResult, QqHmacAlgorithm } from './types'

const log = scoped('qq')

/** SQLite 明文文件头（16 字节常量） */
const SQLITE_HDR = Buffer.from('SQLite format 3\0', 'ascii')
/** QQ 文件头长度：前 1024 字节不是密文 */
const FILE_HEADER_LEN = 1024
/** SQLCipher 4 页面大小 */
const PAGE_SIZE = 4096
/** IV 长度 */
const IV_LEN = 16
/** KDF 迭代次数（QQFlow PRAGMA kdf_iter = 4000） */
const KDF_ITER = 4000
/** 循环 XOR 密钥（QQFlow commands.rs::XOR_KEY），用于解读 QQFlow 密钥文件 */
const QQFLOW_XOR_KEY = Buffer.from('QQFlow2024!@#$%^', 'ascii')

/**
 * 候选页面布局（预留区大小 = IV 16 + HMAC）。
 * 为什么是这几个值：
 *   - 密文区长度必须能被 AES 块大小 16 整除 → 预留区必须是 16 的倍数
 *   - HMAC_SHA512 → 16+64 = 80（QQFlow 的 HMAC_SHA512 回退分支）
 *   - HMAC_SHA256 → 16+32 = 48
 *   - HMAC_SHA1   → 16+20 = 36，不是 16 的倍数；SQLCipher 实际会把预留区向上取整
 *                  到块大小 → 48。故 48 同时覆盖 SHA1 与 SHA256
 * 逐个试，用第 1 页自校验挑出正确的那个。
 */
const RESERVE_CANDIDATES: { hmac: QqHmacAlgorithm; reserve: number }[] = [
  { hmac: 'SHA512', reserve: 80 },
  { hmac: 'SHA1', reserve: 48 },
  { hmac: 'SHA256', reserve: 48 }
]

/* ==================================================================
 * 底层：单页解密
 * ================================================================== */

/** 派生 AES-256 密钥：PBKDF2-HMAC-SHA512(passphrase, salt, 4000, 32) */
function deriveAesKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, KDF_ITER, 32, 'sha512')
}

/**
 * 解出一页的明文。
 * @param page 完整（或末页残缺）的密文页
 * @param iv   从预留区取出的 IV
 * @param aesKey 派生密钥
 * @param reserve 预留区大小
 * @param isFirst 是否第 1 页（第 1 页密文从偏移 16 开始）
 */
function decryptPage(
  page: Buffer,
  iv: Buffer,
  aesKey: Buffer,
  reserve: number,
  isFirst: boolean
): Buffer {
  const start = isFirst ? IV_LEN : 0
  const end = page.length - reserve
  if (end <= start) throw new Error('页面长度不足，无法解密')
  const ciphertext = page.subarray(start, end)

  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv)
  decipher.setAutoPadding(false) // SQLCipher 不做 PKCS#7 填充
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  // 明文页 = 解密结果 + 预留区清零
  const out = Buffer.alloc(page.length)
  plain.copy(out, start)
  if (isFirst) {
    // 第 1 页前 16 字节是常量文件头（SQLCipher 用 salt 顶掉了原始魔数）
    SQLITE_HDR.copy(out, 0)
  }
  return out
}

/**
 * 自校验：判断按某候选布局解出的第 1 页是否像合法 SQLite 页。
 *
 * 为什么不用「是否以 SQLite format 3\0 开头」当判据：
 *   SQLCipher 的第 1 页前 16 字节是**常量**（salt 顶掉了魔数），任何密钥解出来
 *   都能匹配——用它当判据等于没判。真正随密钥变化的是 offset 16 之后的内容：
 *     - [16..18] 页大小（大端），必须是 4096
 *     - [18]/[19] 写/读格式版本，1 或 2
 *     - [21..24] 页内预留字节 / 载荷比例：64 / 32 / 32
 *     - [100] 第 1 页 b-tree 页类型：0x0D（叶子表）或 0x05（内部表）
 *   这几点同时成立才认定密钥+布局正确。
 */
function validatePage1(plain: Buffer): boolean {
  if (plain.length < 128) return false
  if (!plain.subarray(0, 16).equals(SQLITE_HDR)) return false

  const pageSize = plain.readUInt16BE(16)
  if (pageSize !== 4096 && pageSize !== 65536) return false // 允许 SQLite 特例 65536

  const writeVer = plain[18]
  const readVer = plain[19]
  if ((writeVer !== 1 && writeVer !== 2) || (readVer !== 1 && readVer !== 2)) return false

  if (plain[21] !== 64 || plain[22] !== 32 || plain[23] !== 32) return false

  const pageType = plain[100]
  if (pageType !== 0x0d && pageType !== 0x05) return false

  return true
}

/* ==================================================================
 * 主流程
 * ================================================================== */

/** 该 buffer 是否以 SQLite 明文文件头开头 */
export function isPlainSqlite(buf: Buffer): boolean {
  return buf.length >= 16 && buf.subarray(0, 16).equals(SQLITE_HDR)
}

/** 取临时目录（wx-msg-grb-qq 子目录），不存在则创建 */
function tempDir(): string {
  const dir = join(tmpdir(), 'wx-msg-grb-qq')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 用「路径 + 大小 + mtime + 密钥指纹」算缓存文件名（内容 hash） */
function cacheFileName(dbPath: string, st: { size: number; mtimeMs: number }, key: string): string {
  const h = createHash('sha256')
  h.update(dbPath)
  h.update('|')
  h.update(String(st.size))
  h.update('|')
  h.update(String(Math.round(st.mtimeMs)))
  h.update('|')
  h.update(key)
  return `${h.digest('hex').slice(0, 32)}.sqlite`
}

/**
 * 把「密文 payload」解密为明文 SQLite 字节。
 * payload 已去掉文件头。失败抛中文错误。
 * 异步：每处理若干页让出一次事件循环，避免长任务把 Electron 主线程卡死。
 */
async function decryptPayload(
  payload: Buffer,
  key: string,
  onProgress?: QqDecryptProgress
): Promise<{ bytes: Buffer; hmac: QqHmacAlgorithm }> {
  if (payload.length < PAGE_SIZE) {
    throw errors.io('QQ 数据库内容过短，无法解密（可能文件损坏或被截断）')
  }

  const salt = payload.subarray(0, IV_LEN)
  onProgress?.('derive-key', 0)
  await yieldToEventLoop()
  const aesKey = deriveAesKey(key, Buffer.from(salt))

  // ── 逐个候选布局试解第 1 页，用自校验挑出正确的 ──
  let chosen: { hmac: QqHmacAlgorithm; reserve: number } | null = null
  let firstPagePlain: Buffer | null = null
  for (const cand of RESERVE_CANDIDATES) {
    const first = payload.subarray(0, Math.min(PAGE_SIZE, payload.length))
    // 预留区必须能让密文区被 16 整除，否则不可能是它
    if ((first.length - cand.reserve - IV_LEN) % 16 !== 0) continue
    const ivStart = PAGE_SIZE - cand.reserve
    if (ivStart + IV_LEN > first.length) continue
    try {
      const iv = first.subarray(ivStart, ivStart + IV_LEN)
      const plain = decryptPage(first, Buffer.from(iv), aesKey, cand.reserve, true)
      if (validatePage1(plain)) {
        chosen = cand
        firstPagePlain = plain
        break
      }
    } catch (e) {
      log.debug('候选布局试解第 1 页失败，继续下一个', { reserve: cand.reserve, error: String(e) })
    }
  }

  if (!chosen || !firstPagePlain) {
    throw errors.io(
      'QQ 数据库解密失败：密钥不正确，或该库使用了本程序尚未支持的加密参数',
      '已尝试的页面布局（预留区）：' +
        RESERVE_CANDIDATES.map((c) => `${c.hmac}:${c.reserve}`).join(', ') +
        '。若密钥确认无误，请改用「QQFlow 导出 TXT 后再读取」这条兜底路线。'
    )
  }

  log.info('确定页面布局', { hmac: chosen.hmac, reserve: chosen.reserve, pageSize: PAGE_SIZE })

  // ── 解密全部页面 ──
  const totalPages = Math.ceil(payload.length / PAGE_SIZE)
  const out = Buffer.alloc(payload.length)
  firstPagePlain.copy(out, 0, 0, Math.min(PAGE_SIZE, payload.length))

  for (let p = 1; p < totalPages; p++) {
    const page = payload.subarray(p * PAGE_SIZE, Math.min((p + 1) * PAGE_SIZE, payload.length))
    const ivStart = PAGE_SIZE - chosen.reserve
    if (page.length - chosen.reserve < IV_LEN) {
      // 末页残缺且不足以容纳预留区：直接原样保留（SQLite 不会用到）
      page.copy(out, p * PAGE_SIZE)
      continue
    }
    const iv = page.subarray(ivStart, ivStart + IV_LEN)
    const plain = decryptPage(page, Buffer.from(iv), aesKey, chosen.reserve, false)
    plain.copy(out, p * PAGE_SIZE)

    if (p % 256 === 0) {
      onProgress?.('decrypt', p / totalPages)
      await yieldToEventLoop()
    }
  }

  onProgress?.('decrypt', 1)
  return { bytes: out, hmac: chosen.hmac }
}

/** 让出一次事件循环（把长任务切碎，保持主线程可响应） */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 把原文件整理成「待解密的密文 payload」。
 * 处理三种情况：明文（头在 0）、明文（头在 1024）、密文（跳过 1024 头）。
 */
function preparePayload(raw: Buffer): { payload: Buffer; plaintext: boolean } {
  if (isPlainSqlite(raw)) {
    return { payload: raw, plaintext: true }
  }
  if (raw.length > FILE_HEADER_LEN + 16 && isPlainSqlite(raw.subarray(FILE_HEADER_LEN))) {
    return { payload: raw.subarray(FILE_HEADER_LEN), plaintext: true }
  }
  // 默认：前 1024 字节是文件头，其后是密文
  if (raw.length <= FILE_HEADER_LEN) {
    throw errors.io('QQ 数据库文件过小（不足 1024 字节的文件头），可能不是有效的 nt_msg.db')
  }
  return { payload: raw.subarray(FILE_HEADER_LEN), plaintext: false }
}

/**
 * 尝试从 QQFlow 的临时缓存目录里找可用的库。
 *
 * ⚠️ 已核实：QQFlow 缓存**仍是加密的**（只去掉 1024 头）。所以这里只在
 * 「缓存文件恰好是明文 SQLite」时才采用（用户可能用别的方式放进去过），
 * 否则返回 null。真正的兜底是让用户走 QQFlow 导出 TXT。
 */
function tryQqflowCache(): Buffer | null {
  try {
    const dir = qqflowCacheDir()
    if (!existsSync(dir)) return null
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.txt')) continue
      const full = join(dir, name)
      try {
        if (!statSync(full).isFile()) continue
        // 只读文件头 16 字节判断是不是明文库，绝不把整个缓存读进来
        const fd = openSync(full, 'r')
        const head = Buffer.alloc(16)
        let read = 0
        try {
          read = readSync(fd, head, 0, 16, 0)
        } finally {
          closeSync(fd)
        }
        if (read === 16 && isPlainSqlite(head)) {
          log.info('发现 QQFlow 缓存中的明文库，直接复用', { full })
          return readFileSync(full)
        }
      } catch {
        /* 单个缓存文件不可读则跳过 */
      }
    }
  } catch (e) {
    log.warn('检查 QQFlow 缓存目录失败', { error: String(e) })
  }
  return null
}

/**
 * 解密一个 QQ 数据库到临时明文文件，返回明文内容与路径。
 *
 * - 若原文件已是明文 → 直接复制到临时文件（降级路径 A）
 * - 否则按 SQLCipher 4 解密（多候选布局 + 第 1 页自校验）
 * - 临时文件名 = 内容 hash，命中缓存则直接复用（不重复解密大库）
 */
export async function decryptQqDatabase(
  dbPath: string,
  key: string,
  onProgress?: QqDecryptProgress
): Promise<QqDecryptResult> {
  onProgress?.('read', 0)

  let st: { size: number; mtimeMs: number }
  try {
    const s = statSync(dbPath)
    st = { size: s.size, mtimeMs: s.mtimeMs }
  } catch (e) {
    throw errors.io('读取 QQ 数据库文件失败（文件不存在或没有权限）', `${dbPath}\n${String(e)}`)
  }

  // 缓存命中检查
  const cachePath = join(tempDir(), cacheFileName(dbPath, st, key))
  try {
    if (existsSync(cachePath)) {
      const cached = readFileSync(cachePath)
      if (isPlainSqlite(cached)) {
        log.info('复用已解密的临时明文库', { cachePath, sizeMb: (cached.length / 1048576).toFixed(1) })
        onProgress?.('done', 1)
        return { plainPath: cachePath, bytes: cached, hmac: 'none', pageSize: PAGE_SIZE, cached: true, plaintextSource: false }
      }
    }
  } catch {
    /* 缓存不可用则重新解密 */
  }

  let raw: Buffer
  try {
    raw = readFileSync(dbPath)
  } catch (e) {
    throw errors.io('读取 QQ 数据库文件失败', `${dbPath}\n${String(e)}`)
  }
  onProgress?.('read', 1)

  // 降级路径 A / 正常路径
  let payload: Buffer
  let plaintextSource = false
  try {
    const prepared = preparePayload(raw)
    payload = prepared.payload
    plaintextSource = prepared.plaintext
  } catch (e) {
    // 原文件连头都不对 → 试试 QQFlow 缓存（降级路径 B）
    const cached = tryQqflowCache()
    if (cached) {
      writePlainTemp(cachePath, cached)
      onProgress?.('done', 1)
      return { plainPath: cachePath, bytes: cached, hmac: 'none', pageSize: PAGE_SIZE, cached: false, plaintextSource: true }
    }
    throw e
  }

  let bytes: Buffer
  let hmac: QqHmacAlgorithm
  if (plaintextSource) {
    // 已经是明文（可能是别人解密后覆盖的库）
    bytes = payload
    hmac = 'none'
    log.info('该 QQ 数据库已是明文，跳过解密', { dbPath })
  } else {
    const result = await decryptPayload(payload, key, onProgress)
    bytes = result.bytes
    hmac = result.hmac
  }

  onProgress?.('write', 0)
  writePlainTemp(cachePath, bytes)
  onProgress?.('write', 1)
  onProgress?.('done', 1)

  log.info('QQ 数据库解密完成', {
    文件: dbPath,
    密文MB: (raw.length / 1048576).toFixed(1),
    明文MB: (bytes.length / 1048576).toFixed(1),
    hmac
  })

  return { plainPath: cachePath, bytes, hmac, pageSize: PAGE_SIZE, cached: false, plaintextSource }
}

/** 原子写临时明文文件（先写 .tmp 再改名，避免半截文件被当成缓存） */
function writePlainTemp(target: string, bytes: Buffer): void {
  try {
    const tmp = `${target}.tmp`
    writeFileSync(tmp, bytes)
    // Node 的 rename 会覆盖目标；Windows 上先删目标更稳
    try {
      unlinkSync(target)
    } catch {
      /* 目标不存在时忽略 */
    }
    renameSync(tmp, target)
  } catch (e) {
    log.warn('写临时明文库失败（不影响本次读取，只是下次要重解）', {
      target,
      error: String(e)
    })
  }
}

/* ==================================================================
 * QQFlow 密钥解读（供 keys.ts 复用，放这里是因为它属于"解密"范畴）
 * ================================================================== */

/**
 * 解读 QQFlow 的一条 base64 密钥：base64 → XOR 循环密钥 → 明文。
 * 逐字对应 commands.rs::deobfuscate_key。
 * 返回 null 表示不是合法的 16 字节密钥。
 */
export function deobfuscateQqflowKey(encodedB64: string): string | null {
  let raw: Buffer
  try {
    raw = Buffer.from(encodedB64, 'base64')
  } catch {
    return null
  }
  if (raw.length === 0) return null
  const decoded = Buffer.alloc(raw.length)
  for (let i = 0; i < raw.length; i++) {
    decoded[i] = raw[i] ^ QQFLOW_XOR_KEY[i % QQFLOW_XOR_KEY.length]
  }
  const key = decoded.toString('utf8')
  // QQFlow 要求解出来正好 16 字节（这里按 UTF-8 字节长度校验）
  return Buffer.byteLength(key, 'utf8') === 16 ? key : null
}

/** 反向：把明文密钥写成 QQFlow 的 base64 形式（目前只用于示例/测试） */
export function obfuscateQqflowKey(key: string): string {
  const raw = Buffer.from(key, 'utf8')
  const out = Buffer.alloc(raw.length)
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] ^ QQFLOW_XOR_KEY[i % QQFLOW_XOR_KEY.length]
  }
  return out.toString('base64')
}
