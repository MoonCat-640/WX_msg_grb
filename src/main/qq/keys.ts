/**
 * QQ 密钥管理
 * ------------------------------------------------------------------
 * 密钥来源只有两条（本程序**不注入 QQ 进程**，那条路纯 Node 做不到）：
 *   ① 复用 QQFlow 已提取好的密钥文件
 *         %APPDATA%\qqflow\qqflow_keys.json
 *         结构 { "<QQ号>": "<base64>" }，base64 内容是
 *         「明文密钥 XOR 循环密钥 "QQFlow2024!@#$%^"」再 base64
 *      （对应 QQFlow commands.rs 的 obfuscate_key / deobfuscate_key）
 *   ② 用户在界面上手动粘贴 16 字节密钥
 *
 * 两者最终都写进**本应用的加密保险库**（core/vault.ts 的 AES-256-GCM），
 * 以加密文本形式落在 <userData>/qq-keys.json 里，之后不用重复输入。
 *
 * 为什么单独放一个文件而不是塞进 sql.js 的主库：
 *   密钥要在保险库刚解锁、主库还没初始化时就能读到；独立文件依赖更少、更稳。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errors } from '@main/core/errors'
import { scoped } from '@main/core/logger'
import { ensureDir, getAppPaths } from '@main/core/paths'
import { decryptString, encryptString } from '@main/core/vault'
import { deobfuscateQqflowKey } from './decrypt'
import { qqflowKeyFilePath } from './locator'
import type { QqKeyStoreFile } from './types'

const log = scoped('qq')

/** 本应用密钥库文件路径 */
function keyStorePath(): string {
  return join(getAppPaths().dataDir, 'qq-keys.json')
}

/* ==================================================================
 * 校验
 * ================================================================== */

/**
 * 校验 QQ 密钥形态。
 * 逐字对应 QQFlow commands.rs::read_key_from_r8 的判据：
 *   长度 16 字节，且每个字符都是可打印 ASCII（32..=126）。
 * （SQLCipher 的 PRAGMA key 会原样使用这段字节做口令，QQ 产出的就是 16 个可见字符。）
 */
export function validateQqKey(key: string): { ok: boolean; message: string } {
  if (!key) return { ok: false, message: '密钥为空' }
  const bytes = Buffer.from(key, 'utf8')
  if (bytes.length !== 16) {
    return { ok: false, message: `密钥长度应为 16 字节，当前为 ${bytes.length} 字节` }
  }
  for (const b of bytes) {
    if (b < 32 || b > 126) {
      return { ok: false, message: '密钥含不可打印字符，QQ 密钥应是 16 个可见 ASCII 字符' }
    }
  }
  return { ok: true, message: '密钥格式正确' }
}

/* ==================================================================
 * 本应用密钥库（加密存储）
 * ================================================================== */

function readKeyStore(): QqKeyStoreFile {
  const file = keyStorePath()
  if (!existsSync(file)) return { version: 1, updatedAt: 0, keys: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as QqKeyStoreFile
    if (!raw || typeof raw !== 'object' || typeof raw.keys !== 'object' || raw.keys === null) {
      throw new Error('密钥库结构不完整')
    }
    return { version: raw.version ?? 1, updatedAt: raw.updatedAt ?? 0, keys: raw.keys }
  } catch (e) {
    log.error('QQ 密钥库文件损坏或无法解析', { file, error: String(e) })
    throw errors.io('QQ 密钥库文件损坏，无法读取', String(e))
  }
}

function writeKeyStore(store: QqKeyStoreFile): void {
  const file = keyStorePath()
  ensureDir(getAppPaths().dataDir)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  try {
    unlinkSync(file)
  } catch {
    /* 目标不存在时忽略 */
  }
  renameSync(tmp, file)
}

/** 从本应用保险库取某个 QQ 号的密钥；没有或保险库锁定返回 null */
export function getQqKey(qq: string): string | null {
  let store: QqKeyStoreFile
  try {
    store = readKeyStore()
  } catch {
    return null
  }
  const enc = store.keys[qq]
  if (!enc) return null
  try {
    const key = decryptString(enc)
    return validateQqKey(key).ok ? key : null
  } catch (e) {
    // 保险库锁定或密文损坏：返回 null，让上层提示用户
    log.warn('读取 QQ 密钥失败（保险库可能未解锁）', { qq, error: String(e) })
    return null
  }
}

/** 把密钥存进本应用保险库（加密）。保险库未解锁会抛错。 */
export function saveQqKey(qq: string, key: string): void {
  const v = validateQqKey(key)
  if (!v.ok) throw errors.invalidArg(`无法保存 QQ 密钥：${v.message}`, `qq=${qq}`)
  if (!qq) throw errors.invalidArg('无法保存 QQ 密钥：缺少 QQ 号')

  const store = readKeyStore()
  store.keys[qq] = encryptString(key) // 未解锁时 encryptString 会抛 locked
  store.updatedAt = Date.now()
  writeKeyStore(store)
  log.info('已保存 QQ 密钥到本应用保险库', { qq })
}

/** 删除某个 QQ 号的密钥（用于界面「清除密钥」） */
export function deleteQqKey(qq: string): void {
  const store = readKeyStore()
  if (store.keys[qq]) {
    delete store.keys[qq]
    store.updatedAt = Date.now()
    writeKeyStore(store)
    log.info('已删除 QQ 密钥', { qq })
  }
}

/** 列出本应用已保存密钥的 QQ 号（不返回密钥本身） */
export function listQqKeyAccounts(): string[] {
  try {
    return Object.keys(readKeyStore().keys)
  } catch {
    return []
  }
}

/* ==================================================================
 * QQFlow 密钥文件
 * ================================================================== */

/**
 * 读 QQFlow 的密钥文件并解出明文密钥。
 * 返回 { QQ号: 明文密钥 }；文件不存在/损坏/条目非法时跳过对应项，不抛错。
 * （逐字对应 QQFlow commands.rs::load_keys + deobfuscate_key 的行为）
 */
export function readQqflowKeys(): Record<string, string> {
  const file = qqflowKeyFilePath()
  const out: Record<string, string> = {}
  if (!existsSync(file)) {
    log.info('未找到 QQFlow 密钥文件', { file })
    return out
  }
  let json: Record<string, unknown>
  try {
    json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (e) {
    log.warn('QQFlow 密钥文件无法解析', { file, error: String(e) })
    return out
  }
  for (const [qq, val] of Object.entries(json)) {
    if (typeof val !== 'string') continue
    const key = deobfuscateQqflowKey(val)
    if (key === null) {
      log.warn('QQFlow 密钥条目非法，已跳过', { qq })
      continue
    }
    out[qq] = key
  }
  log.info('已读取 QQFlow 密钥', { file, 数量: Object.keys(out).length })
  return out
}

/**
 * 从 QQFlow 密钥文件导入到本应用保险库。
 * @param qq 指定只导入某一个 QQ 号；不传则导入全部
 * @returns 成功导入的条数
 */
export function importKeysFromQqflow(qq?: string): number {
  const all = readQqflowKeys()
  let count = 0
  for (const [account, key] of Object.entries(all)) {
    if (qq && qq !== account) continue
    try {
      saveQqKey(account, key)
      count++
    } catch (e) {
      // 最可能是保险库未解锁——记日志并跳过，不中断整体导入
      log.warn('导入 QQFlow 密钥失败', { qq: account, error: String(e) })
    }
  }
  log.info('QQFlow 密钥导入完成', { 导入: count, 指定qq: qq ?? '全部' })
  return count
}
