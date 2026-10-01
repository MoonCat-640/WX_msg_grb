/**
 * QQ 读取层 —— 统一入口
 * ------------------------------------------------------------------
 * 上层（IPC / 同步编排 / 任务抽取）只从这里调用，不关心内部的
 * 「定位 → 解密 → sql.js 读表 → 解析 BLOB」四步。
 *
 * 三个必须导出的函数（名字固定）：
 *   isQqDatabaseReadable(dbPath)
 *   listQqConversations(accountId, dbPath, key)
 *   listQqMessages(accountId, dbPath, key, conversationId, opts)
 *
 * 失败一律抛 AppFailure（中文提示），由上层包成 { ok:false, error }，
 * 绝不把裸异常/半截数据丢给界面。
 */
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Database as SqlDatabase } from 'sql.js'
import type { ChatMessage, Conversation } from '@shared/types'
import { errors } from '@main/core/errors'
import { scoped } from '@main/core/logger'
import { decryptQqDatabase, isPlainSqlite } from './decrypt'
import {
  listC2cConversations,
  listGroupConversations,
  loadGroupNames,
  loadUidMap,
  openPlainDb,
  readC2cMessages,
  readGroupMessages
} from './reader'
import type { ListQqMessagesOptions, QqReadableProbe } from './types'

const log = scoped('qq')

/* ==================================================================
 * 可读性探测
 * ================================================================== */

/**
 * 轻量探测：文件是否存在、可读、是否像 QQ 数据库。
 * 注意：**真正的可读性还取决于密钥是否正确**，这里只做「文件层面」的检查，
 * 供界面在让用户填密钥之前先排除明显问题（路径写错、文件被占用等）。
 */
export function isQqDatabaseReadable(dbPath: string): QqReadableProbe {
  if (!dbPath) return { ok: false, message: '未指定数据库路径' }
  if (!existsSync(dbPath)) return { ok: false, message: '数据库文件不存在，请确认 QQ 数据目录是否正确' }
  try {
    const st = statSync(dbPath)
    if (!st.isFile()) return { ok: false, message: '指定的路径不是一个文件' }
    if (st.size <= 1024) {
      return { ok: false, message: '数据库文件过小（不足 1024 字节的文件头），可能不是有效的 nt_msg.db' }
    }
    // 读前 1040 字节，判断是明文库还是加密库
    const fd = openSync(dbPath, 'r')
    const head = Buffer.alloc(1040)
    let read = 0
    try {
      read = readSync(fd, head, 0, 1040, 0)
    } finally {
      closeSync(fd)
    }
    if (read >= 16 && isPlainSqlite(head.subarray(0, 16))) {
      return { ok: true, message: '数据库可读（明文库，无需密钥）' }
    }
    if (read >= 1040 && isPlainSqlite(head.subarray(1024, 1040))) {
      return { ok: true, message: '数据库可读（明文库，无需密钥）' }
    }
    return { ok: true, message: '数据库可读（加密库，需要提供 16 字节密钥才能解密）' }
  } catch (e) {
    log.warn('探测 QQ 数据库失败', { dbPath, error: String(e) })
    return { ok: false, message: `无法读取数据库文件：${e instanceof Error ? e.message : String(e)}` }
  }
}

/* ==================================================================
 * 已打开库的缓存
 * ------------------------------------------------------------------
 * 解密一个大库要读盘 + PBKDF2 + 逐页 AES，很贵；而列会话/读消息会反复调用。
 * 因此按「路径 + 密钥指纹」缓存已解密的 sql.js 内存库，最多保留 2 个
 * （够覆盖「主账号 + 全局库」的常见用法），超出时释放最旧的。
 * ================================================================== */

interface CachedDb {
  db: SqlDatabase
  uidMap: Map<string, string>
  groupNames: Map<string, string>
  loadedAt: number
}

const dbCache = new Map<string, CachedDb>()
const MAX_CACHED_DBS = 2

function cacheKey(dbPath: string, key: string): string {
  const h = createHash('sha256')
  h.update(dbPath)
  h.update('|')
  h.update(key)
  return h.digest('hex').slice(0, 24)
}

async function ensureLoaded(dbPath: string, key: string): Promise<CachedDb> {
  const ck = cacheKey(dbPath, key)
  const hit = dbCache.get(ck)
  if (hit) return hit

  if (!key) throw errors.invalidArg('缺少 QQ 数据库密钥，请先导入或粘贴 16 字节密钥')

  log.info('准备加载 QQ 数据库', { dbPath })
  const result = await decryptQqDatabase(dbPath, key, (stage, ratio) => {
    // 分阶段日志：解密大库时进度可见
    log.info('QQ 解密进度', {
      stage,
      percent: ratio === undefined ? undefined : `${Math.round(ratio * 100)}%`
    })
  })

  const db = await openPlainDb(result.bytes)
  const uidMap = loadUidMap(db)
  const groupNames = loadGroupNames(db)

  const entry: CachedDb = { db, uidMap, groupNames, loadedAt: Date.now() }
  dbCache.set(ck, entry)

  // 释放超出上限的旧库
  if (dbCache.size > MAX_CACHED_DBS) {
    const oldest = [...dbCache.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt)[0]
    if (oldest) {
      try {
        oldest[1].db.close()
      } catch {
        /* 关闭失败忽略 */
      }
      dbCache.delete(oldest[0])
    }
  }

  log.info('QQ 数据库已打开', {
    数据库: dbPath,
    hmac: result.hmac,
    UID映射: uidMap.size,
    群名称: groupNames.size,
    明文MB: (result.bytes.length / 1048576).toFixed(1)
  })
  return entry
}

/** 清空已打开的库缓存（切换账号 / 释放内存时调用） */
export function clearQqDbCache(): void {
  for (const [, v] of dbCache) {
    try {
      v.db.close()
    } catch {
      /* 忽略 */
    }
  }
  dbCache.clear()
  log.info('已清空 QQ 数据库缓存')
}

/* ==================================================================
 * 对上层的能力
 * ================================================================== */

/**
 * 列出某个 QQ 库里全部会话（群聊 + 私聊）。
 * 名称解析：群用群名称表，私聊用 UID→QQ 号 映射，都没有则回落到原生 id。
 * 结果按最近消息时间倒序。
 */
export async function listQqConversations(
  accountId: string,
  dbPath: string,
  key: string
): Promise<Conversation[]> {
  const { db, uidMap, groupNames } = await ensureLoaded(dbPath, key)

  const groups = listGroupConversations(db, accountId, groupNames)
  const c2cs = listC2cConversations(db, accountId, uidMap)
  const all = [...groups, ...c2cs]

  all.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  log.info('已列出 QQ 会话', { 群: groups.length, 私聊: c2cs.length })
  return all
}

/**
 * 读某个会话的最近 N 条消息（时间升序）。
 * conversationId 允许两种写法：`${accountId}:${platformId}` 或裸 platformId。
 * 内部自动判定是群还是私聊（群号在 group_msg_table 里，对端 UID 在 c2c_msg_table 里）。
 */
export async function listQqMessages(
  accountId: string,
  dbPath: string,
  key: string,
  conversationId: string,
  opts: ListQqMessagesOptions = {}
): Promise<ChatMessage[]> {
  const { db, uidMap } = await ensureLoaded(dbPath, key)

  const platformId = stripAccountPrefix(conversationId, accountId)
  if (!platformId) throw errors.invalidArg('会话 id 为空，无法读取消息')

  if (isGroupId(db, platformId)) {
    return readGroupMessages(db, accountId, platformId, uidMap, opts)
  }
  return readC2cMessages(db, accountId, platformId, uidMap, opts)
}

/** 去掉 `${accountId}:` 前缀（若存在），返回平台侧 id */
function stripAccountPrefix(conversationId: string, accountId: string): string {
  const prefix = `${accountId}:`
  if (accountId && conversationId.startsWith(prefix)) return conversationId.slice(prefix.length)
  // 兜底：按第一个 ':' 切（accountId 里不含 ':'）
  const idx = conversationId.indexOf(':')
  return idx >= 0 ? conversationId.slice(idx + 1) : conversationId
}

/** 判断某 id 是群号（在 group_msg_table 里出现过） */
function isGroupId(db: SqlDatabase, id: string): boolean {
  try {
    const stmt = db.prepare('SELECT count(*) FROM group_msg_table WHERE "40021" = ? LIMIT 1')
    try {
      stmt.bind([id])
      if (stmt.step()) {
        const row = stmt.get()
        const n = row[0]
        return typeof n === 'number' ? n > 0 : false
      }
      return false
    } finally {
      stmt.free()
    }
  } catch (e) {
    log.warn('判定会话类型失败，按私聊处理', { id, error: String(e) })
    return false
  }
}
