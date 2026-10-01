/**
 * 加密保险库（PBKDF2 + AES-256-GCM）
 * ------------------------------------------------------------------
 * 对应需求的「模块 10：加密与安全」：
 *   - 所有敏感信息（账号、密钥、聊天数据）使用 PBKDF2 加密存储
 *   - 数据库文件加密，防止外部读取
 *
 * 实现要点：
 *   1. 主口令（Master Password）经 PBKDF2-HMAC-SHA512 派生 32 字节密钥
 *      —— 迭代 210000 次，每次启动都真实计算（不做缓存加速，避免降低强度）
 *   2. 派生密钥用于 AES-256-GCM 加密；GCM 自带完整性校验，密文被篡改会直接抛错
 *   3. 主口令本身不明文落盘：
 *      - 开启「自动解锁」时，用 Electron safeStorage（Windows 下即 DPAPI，
 *        绑定当前 Windows 用户）加密后存入 vault.key
 *      - 关闭时只保留校验块，每次启动需用户输入
 *   4. 校验块（verifier）= 加密一个固定魔数；解锁时试解，成功即口令正确
 */
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { VaultStatus } from '@shared/types'
import { errors } from './errors'
import { scoped } from './logger'
import { ensureDir, vaultFilePath, vaultKeyFilePath } from './paths'

const log = scoped('vault')

/** PBKDF2 迭代次数（OWASP 对 PBKDF2-HMAC-SHA512 的建议值） */
const ITERATIONS = 210_000
const KEY_LENGTH = 32 // AES-256
const SALT_LENGTH = 16
const IV_LENGTH = 12 // GCM 推荐 96 bit
const VERIFIER_MAGIC = 'WX_MSG_GRB_VAULT_V1'

interface EncBlob {
  iv: string
  tag: string
  ct: string
}

interface VaultFile {
  version: number
  kdf: 'PBKDF2-HMAC-SHA512'
  iterations: number
  saltLength: number
  keyLength: number
  cipher: 'AES-256-GCM'
  /** base64 盐 */
  salt: string
  /** 校验块 */
  verifier: EncBlob
  /** 是否允许自动解锁（用 safeStorage 保存口令） */
  autoUnlock: boolean
  createdAt: number
  updatedAt: number
}

/** 当前进程内存中的派生密钥；为 null 表示已锁定 */
let derivedKey: Buffer | null = null
let vaultCache: VaultFile | null = null

/* ------------------------------------------------------------------ */
/* 基础编解码                                                          */
/* ------------------------------------------------------------------ */

function b64(buf: Buffer): string {
  return buf.toString('base64')
}

function unb64(s: string): Buffer {
  return Buffer.from(s, 'base64')
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha512')
}

function encryptWithKey(key: Buffer, plain: Buffer): EncBlob {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) }
}

function decryptWithKey(key: Buffer, blob: EncBlob): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(blob.iv))
  decipher.setAuthTag(unb64(blob.tag))
  return Buffer.concat([decipher.update(unb64(blob.ct)), decipher.final()])
}

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

function readVaultFile(): VaultFile | null {
  if (vaultCache) return vaultCache
  const file = vaultFilePath()
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as VaultFile
    if (!raw.salt || !raw.verifier) throw new Error('保险库文件结构不完整')
    vaultCache = raw
    return raw
  } catch (e) {
    log.error('保险库文件损坏或无法解析', { file, error: String(e) })
    throw errors.io('保险库文件损坏，无法读取。请查看日志确认路径后手动处理', String(e))
  }
}

function writeVaultFile(data: VaultFile): void {
  const file = vaultFilePath()
  ensureDir(file.substring(0, file.lastIndexOf('\\')))
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file) // 原子替换，避免半截文件
  vaultCache = data
}

/** 用 safeStorage 保存/清除自动解锁口令 */
function saveAutoUnlockPassword(password: string | null): void {
  const file = vaultKeyFilePath()
  try {
    if (password === null) {
      if (existsSync(file)) unlinkSync(file)
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('当前系统不支持 safeStorage，自动解锁已禁用（每次启动需输入主口令）')
      if (existsSync(file)) unlinkSync(file)
      return
    }
    writeFileSync(file, safeStorage.encryptString(password))
  } catch (e) {
    log.warn('写入自动解锁口令失败', { error: String(e) })
  }
}

function loadAutoUnlockPassword(): string | null {
  const file = vaultKeyFilePath()
  if (!existsSync(file)) return null
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(readFileSync(file))
  } catch (e) {
    log.warn('读取自动解锁口令失败（可能是换了 Windows 用户或系统重装）', { error: String(e) })
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 对外能力                                                            */
/* ------------------------------------------------------------------ */

/** 保险库是否已初始化 */
export function isInitialized(): boolean {
  return existsSync(vaultFilePath())
}

export function isUnlocked(): boolean {
  return derivedKey !== null
}

/** 查询状态 */
export function getVaultStatus(): VaultStatus {
  const file = readVaultFile()
  return {
    initialized: file !== null,
    unlocked: derivedKey !== null,
    autoUnlock: file?.autoUnlock ?? false,
    kdf: {
      algorithm: 'PBKDF2-HMAC-SHA512',
      iterations: ITERATIONS,
      keyLength: KEY_LENGTH,
      cipher: 'AES-256-GCM',
      saltLength: SALT_LENGTH
    }
  }
}

/** 首次初始化：设置主口令 */
export function setupVault(password: string, autoUnlock: boolean): VaultStatus {
  if (isInitialized()) {
    throw errors.invalidArg('保险库已初始化，如需修改请使用「修改主口令」')
  }
  validatePassword(password)
  const salt = randomBytes(SALT_LENGTH)
  const key = deriveKey(password, salt)
  const now = Date.now()
  const file: VaultFile = {
    version: 1,
    kdf: 'PBKDF2-HMAC-SHA512',
    iterations: ITERATIONS,
    saltLength: SALT_LENGTH,
    keyLength: KEY_LENGTH,
    cipher: 'AES-256-GCM',
    salt: b64(salt),
    verifier: encryptWithKey(key, Buffer.from(VERIFIER_MAGIC, 'utf8')),
    autoUnlock,
    createdAt: now,
    updatedAt: now
  }
  writeVaultFile(file)
  derivedKey = key
  saveAutoUnlockPassword(autoUnlock ? password : null)
  log.info('保险库初始化完成', { autoUnlock, iterations: ITERATIONS })
  return getVaultStatus()
}

/** 解锁 */
export function unlockVault(password: string): VaultStatus {
  const file = readVaultFile()
  if (!file) throw errors.notReady('保险库尚未初始化')
  const key = deriveKey(password, unb64(file.salt))
  try {
    const plain = decryptWithKey(key, file.verifier)
    const expected = Buffer.from(VERIFIER_MAGIC, 'utf8')
    if (plain.length !== expected.length || !timingSafeEqual(plain, expected)) {
      throw errors.invalidArg('主口令不正确')
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AppFailure') throw e
    log.warn('解锁失败：口令校验未通过')
    throw errors.invalidArg('主口令不正确')
  }
  derivedKey = key
  log.info('保险库已解锁')
  return getVaultStatus()
}

/**
 * 尝试用已保存的口令自动解锁（启动时调用）。
 * 失败不抛异常，返回 false 让界面弹出解锁框。
 */
export function tryAutoUnlock(): boolean {
  if (derivedKey) return true
  // 调试便利：允许通过环境变量注入主口令（便于自动化测试）
  const envPwd = process.env.WX_GRB_MASTER_PASSWORD
  if (envPwd) {
    try {
      unlockVault(envPwd)
      log.info('已通过环境变量 WX_GRB_MASTER_PASSWORD 解锁')
      return true
    } catch {
      log.warn('环境变量 WX_GRB_MASTER_PASSWORD 无效')
    }
  }
  const file = readVaultFile()
  if (!file || !file.autoUnlock) return false
  const pwd = loadAutoUnlockPassword()
  if (!pwd) return false
  try {
    unlockVault(pwd)
    return true
  } catch {
    return false
  }
}

/** 锁定（清空内存密钥） */
export function lockVault(): VaultStatus {
  if (derivedKey) {
    derivedKey.fill(0)
    derivedKey = null
  }
  log.info('保险库已锁定')
  return getVaultStatus()
}

/** 修改主口令 */
export function changePassword(
  oldPassword: string,
  newPassword: string,
  autoUnlock: boolean
): VaultStatus {
  const file = readVaultFile()
  if (!file) throw errors.notReady('保险库尚未初始化')
  validatePassword(newPassword)
  // 先校验旧口令
  unlockVault(oldPassword)

  const salt = randomBytes(SALT_LENGTH)
  const key = deriveKey(newPassword, salt)
  const updated: VaultFile = {
    ...file,
    salt: b64(salt),
    verifier: encryptWithKey(key, Buffer.from(VERIFIER_MAGIC, 'utf8')),
    autoUnlock,
    updatedAt: Date.now()
  }
  writeVaultFile(updated)
  derivedKey = key
  saveAutoUnlockPassword(autoUnlock ? newPassword : null)
  log.info('主口令已修改', { autoUnlock })
  return getVaultStatus()
}

function validatePassword(password: string): void {
  if (!password || password.length < 6) {
    throw errors.invalidArg('主口令至少 6 位')
  }
}

/** 取当前密钥；未解锁则抛错 */
function requireKey(): Buffer {
  if (!derivedKey) throw errors.locked()
  return derivedKey
}

/* ------------------------------------------------------------------ */
/* 加解密接口（供数据库与字段级加密使用）                                 */
/* ------------------------------------------------------------------ */

/** 加密字符串 → 可存库的紧凑文本 */
export function encryptString(plain: string): string {
  const blob = encryptWithKey(requireKey(), Buffer.from(plain, 'utf8'))
  return `v1.${blob.iv}.${blob.tag}.${blob.ct}`
}

/** 解密字符串 */
export function decryptString(encoded: string): string {
  if (!encoded.startsWith('v1.')) {
    throw errors.invalidArg('密文格式不正确')
  }
  const [, iv, tag, ct] = encoded.split('.')
  return decryptWithKey(requireKey(), { iv, tag, ct }).toString('utf8')
}

/** 加密可序列化对象 */
export function encryptJson(value: unknown): string {
  return encryptString(JSON.stringify(value))
}

/** 解密为对象 */
export function decryptJson<T>(encoded: string): T {
  return JSON.parse(decryptString(encoded)) as T
}

/** 加密二进制（用于整库文件加密） */
export function encryptBuffer(plain: Buffer): Buffer {
  const blob = encryptWithKey(requireKey(), plain)
  // 自定义容器：MAGIC(4) + iv(12) + tag(16) + ct
  const header = Buffer.from('WXG1', 'ascii')
  return Buffer.concat([header, unb64(blob.iv), unb64(blob.tag), unb64(blob.ct)])
}

/** 解密二进制 */
export function decryptBuffer(data: Buffer): Buffer {
  if (data.length < 4 + IV_LENGTH + 16) throw errors.invalidArg('加密数据长度不合法')
  const magic = data.subarray(0, 4).toString('ascii')
  if (magic !== 'WXG1') throw errors.invalidArg('加密数据标识不匹配')
  const iv = data.subarray(4, 4 + IV_LENGTH)
  const tag = data.subarray(4 + IV_LENGTH, 4 + IV_LENGTH + 16)
  const ct = data.subarray(4 + IV_LENGTH + 16)
  return decryptWithKey(requireKey(), { iv: b64(iv), tag: b64(tag), ct: b64(ct) })
}

/** 生成一个随机主口令（首次运行「无感加密」用） */
export function generateRandomPassword(): string {
  return randomBytes(24).toString('base64url')
}
