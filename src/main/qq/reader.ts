/**
 * QQ 数据库读取（sql.js）
 * ------------------------------------------------------------------
 * 解码后的明文库是标准 SQLite，用项目已有的 sql.js（WASM）打开即可——
 * 这也正是「必须自己写 SQLCipher 解密」的原因：sql.js 不支持 SQLCipher。
 *
 * 表与列号（逐字来自 QQFlow export_chat.rs::MessageStore::load）：
 *   group_msg_table: "40021"=群号, "40001"=msg_id(同时是时间戳),
 *                    "40020"=发送者 UID, "40093"=发送者昵称, "40800"=消息 BLOB
 *   c2c_msg_table:   "40020"=对端 UID, "40001"=msg_id, "40093"=昵称, "40800"=消息 BLOB
 * 注意：QQ 没有单独的"时间"列，时间戳就存在 msg_id（列 40001）里，
 * 量级可能是纳秒/毫秒/秒（见 analysis.rs::normalize_ts），要归一化。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Database as SqlDatabase, SqlJsStatic, SqlValue } from 'sql.js'
import type { ChatMessage, Conversation } from '@shared/types'
import { scoped } from '@main/core/logger'
import { getAppPaths } from '@main/core/paths'
import { extractText, qqTypeToMessageKind } from './parser'
import type { ListQqMessagesOptions } from './types'

const log = scoped('qq')
const nodeRequire = createRequire(__filename)

/* ==================================================================
 * sql.js 加载（与 core/store.ts 同款：定位 wasm → 用 wasmBinary 初始化）
 * ================================================================== */

/** 定位 sql-wasm.wasm（三种位置依次尝试，与 core/store.ts::locateWasm 一致） */
function locateWasm(): string {
  const candidates: string[] = []
  try {
    candidates.push(nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'))
  } catch {
    /* 继续尝试其它位置 */
  }
  candidates.push(join(process.resourcesPath ?? '', 'sql-wasm.wasm'))
  candidates.push(join(getAppPaths().rootDir, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'))
  candidates.push(join(getAppPaths().resourcesDir, 'sql-wasm.wasm'))
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  throw new Error(`未找到 sql-wasm.wasm，已尝试：\n${candidates.join('\n')}`)
}

let SQL: SqlJsStatic | null = null
let wasmBinaryCache: Buffer | null = null

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (SQL) return SQL
  const initSqlJs = nodeRequire('sql.js') as (cfg?: {
    wasmBinary?: Buffer
    locateFile?: (f: string) => string
  }) => Promise<SqlJsStatic>
  const wasmPath = locateWasm()
  if (!wasmBinaryCache) wasmBinaryCache = readFileSync(wasmPath)
  log.info('加载 SQLite WASM 引擎（QQ）', { wasmPath })
  SQL = await initSqlJs({ wasmBinary: wasmBinaryCache })
  return SQL
}

/* ==================================================================
 * 通用查询工具
 * ================================================================== */

/**
 * 执行一条查询，返回所有行的列值数组。
 * 用 prepare/step 逐行取，避免对大库一次性 exec 把全部 BLOB 读进内存。
 */
function queryRows(db: SqlDatabase, sql: string, params: SqlValue[] = []): SqlValue[][] {
  const rows: SqlValue[][] = []
  const stmt = db.prepare(sql)
  try {
    if (params.length > 0) stmt.bind(params)
    while (stmt.step()) {
      rows.push(stmt.get())
    }
  } finally {
    stmt.free()
  }
  return rows
}

/** 把列值规整成字符串（数字转十进制，BLOB 忽略，null/undefined → ''） */
function asString(v: SqlValue): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return ''
}

/** 把列值规整为数字 */
function asNumber(v: SqlValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** 把列值规整为字节数组（BLOB） */
function asBytes(v: SqlValue): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (typeof v === 'string') return Buffer.from(v, 'binary')
  return new Uint8Array(0)
}

/* ==================================================================
 * 时间戳归一化
 * ================================================================== */

/**
 * 把 QQ 的 msg_id 当时间戳归一化成「毫秒」。
 * 逐字对应 analysis.rs::normalize_ts，再 ×1000 转成毫秒：
 *   > 1e18 → 纳秒（/1e9）> 1e12 → 毫秒（/1e3）否则秒
 * 注意：QQ 的 msg_id 可能超过 2^53，JS Number 会有精度损失，但只用于取到秒级时间，
 * 不影响展示，故不做 BigInt 处理。
 */
export function normalizeTsToMs(ts: number): number {
  if (!Number.isFinite(ts) || ts === 0) return 0
  if (ts > 1e18) return Math.round(ts / 1e9) * 1000
  if (ts > 1e12) return Math.round(ts)
  return Math.round(ts) * 1000
}

/* ==================================================================
 * 打开明文库
 * ================================================================== */

/** 用 sql.js 打开一个明文 SQLite 内存库 */
export async function openPlainDb(bytes: Buffer): Promise<SqlDatabase> {
  const sql = await loadSqlJs()
  return new sql.Database(new Uint8Array(bytes))
}

/* ==================================================================
 * UID → QQ 号 映射（对应 QQFlow export_chat.rs::load_uid_map 的 4 级策略）
 * ================================================================== */

/** 列出所有表及列名 */
function listTables(db: SqlDatabase): { name: string; columns: string[] }[] {
  const out: { name: string; columns: string[] }[] = []
  const names = queryRows(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).map((r) => asString(r[0]))

  for (const name of names) {
    let columns: string[] = []
    try {
      columns = queryRows(db, `PRAGMA table_info(${quoteIdent(name)})`).map((r) => asString(r[1]))
    } catch {
      columns = []
    }
    out.push({ name, columns })
  }
  return out
}

/** 安全转义标识符（表名/列名），避免拼 SQL 出错 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * 加载 UID → QQ 号 映射。4 级策略，与 QQFlow 一一对应：
 *   1. 已知列名（48901=UID, 40020=QQ）在已知表里直接查
 *   2. 候选表名 + 自动检测 UID/QQ 列
 *   3. 模糊搜索表名含 uid/mapping/friend/contact/buddy 的表
 *   4. 暴力扫描所有非消息表
 * 找不到返回空 Map（不是错误——很多库就是没有映射表）。
 */
export function loadUidMap(db: SqlDatabase): Map<string, string> {
  const map = new Map<string, string>()

  // 策略 1：已知列名
  for (const table of ['nt_uid_mapping_table', 'uid_mapping', 'buddy_mapping']) {
    if (tryLoadUidMapDirect(db, table, '48901', '40020', map)) {
      log.info('UID 映射加载成功（已知列名）', { table, 条数: map.size })
      return map
    }
  }

  // 策略 2：候选表自动检测
  const candidates = [
    'nt_uid_mapping_table',
    'uid_mapping',
    'buddy_mapping',
    'contact',
    'friends',
    'buddy_list',
    'Friends',
    'buddys',
    'BuddyInfo',
    'UinPair_Generic',
    'mr_friend_MicroMsg',
    'Friends_Groups'
  ]
  for (const table of candidates) {
    if (tryLoadUidMapAuto(db, table, map)) {
      log.info('UID 映射加载成功（自动检测）', { table, 条数: map.size })
      return map
    }
  }

  // 策略 3：模糊搜索表名
  const fuzzy = queryRows(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND " +
      "(name LIKE '%uid%' OR name LIKE '%mapping%' OR name LIKE '%friend%' OR name LIKE '%contact%' OR name LIKE '%buddy%')"
  ).map((r) => asString(r[0]))
  for (const name of fuzzy) {
    if (tryLoadUidMapAuto(db, name, map)) {
      log.info('UID 映射加载成功（模糊搜索）', { table: name, 条数: map.size })
      return map
    }
  }

  // 策略 4：暴力扫描
  const all = queryRows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) =>
    asString(r[0])
  )
  for (const name of all) {
    if (name.includes('msg') || name.includes('sqlite')) continue
    if (tryLoadUidMapAuto(db, name, map)) {
      log.info('UID 映射加载成功（全表扫描）', { table: name, 条数: map.size })
      return map
    }
  }

  log.info('未找到 UID → QQ 号 映射表（将用 UID 原样展示）')
  return map
}

/** 用已知列名直接查 */
function tryLoadUidMapDirect(
  db: SqlDatabase,
  table: string,
  uidCol: string,
  qqCol: string,
  map: Map<string, string>
): boolean {
  const exists =
    queryRows(db, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name = ?", [table])[0]
  if (asNumber(exists?.[0] ?? 0) === 0) return false

  let rows: SqlValue[][]
  try {
    rows = queryRows(
      db,
      `SELECT ${quoteIdent(uidCol)}, ${quoteIdent(qqCol)} FROM ${quoteIdent(table)} LIMIT 50000`
    )
  } catch {
    return false
  }

  let count = 0
  for (const r of rows) {
    const uid = asString(r[0])
    const qq = asString(r[1])
    if (uid && qq && uid !== qq) {
      map.set(uid, qq)
      count++
    }
  }
  return count > 0
}

/** 自动检测表中的 UID 列与 QQ 列（逐条对应 try_load_uid_map_auto） */
function tryLoadUidMapAuto(db: SqlDatabase, table: string, map: Map<string, string>): boolean {
  let rowCount: number
  try {
    rowCount = asNumber(queryRows(db, `SELECT count(*) FROM ${quoteIdent(table)}`)[0]?.[0] ?? 0)
  } catch {
    return false
  }
  // 行数太少/太多都跳过（与 Rust 一致：<2 或 >200000）
  if (rowCount < 2 || rowCount > 200000) return false

  let columns: { name: string; type: string }[]
  try {
    columns = queryRows(db, `PRAGMA table_info(${quoteIdent(table)})`).map((r) => ({
      name: asString(r[1]),
      type: asString(r[2])
    }))
  } catch {
    return false
  }
  if (columns.length < 2) return false

  let samples: string[][]
  try {
    samples = queryRows(db, `SELECT * FROM ${quoteIdent(table)} LIMIT 5`).map((row) =>
      row.map((v) => asString(v))
    )
  } catch {
    return false
  }
  if (samples.length === 0) return false

  let uidIdx = -1
  let qqIdx = -1

  for (let i = 0; i < columns.length; i++) {
    const lower = columns[i].name.toLowerCase()
    const typeLower = columns[i].type.toLowerCase()

    // 识别 UID 列
    if (uidIdx < 0) {
      if (lower.includes('uid') || lower === 'uin') {
        uidIdx = i
      } else {
        const hasUidVals = samples.some((row) => {
          const v = row[i] ?? ''
          return v.startsWith('u_') || (v.length > 10 && !/^\d+$/.test(v))
        })
        if (hasUidVals && !typeLower.includes('int')) uidIdx = i
      }
    }

    // 识别 QQ 列
    if (qqIdx < 0 && uidIdx !== i) {
      if (lower.includes('qq') || lower.includes('uin') || lower.includes('number')) {
        qqIdx = i
      } else if (typeLower.includes('int')) {
        const hasQqVals = samples.some((row) => {
          const v = row[i] ?? ''
          return v.length >= 5 && v.length <= 12 && /^\d+$/.test(v)
        })
        if (hasQqVals) qqIdx = i
      } else {
        const isQqLike = (v: string): boolean =>
          v.length >= 5 && v.length <= 12 && /^\d+$/.test(v)
        const hasQqVals = samples.every((row) => {
          const v = row[i] ?? ''
          return v === '' || isQqLike(v)
        })
        const hasSomeQq = samples.some((row) => {
          const v = row[i] ?? ''
          return v !== '' && isQqLike(v)
        })
        if (hasQqVals && hasSomeQq) qqIdx = i
      }
    }
  }

  if (uidIdx < 0 || qqIdx < 0) return false

  let rows: SqlValue[][]
  try {
    rows = queryRows(db, `SELECT * FROM ${quoteIdent(table)} LIMIT 50000`)
  } catch {
    return false
  }
  for (const r of rows) {
    const uid = asString(r[uidIdx] ?? '')
    const qq = asString(r[qqIdx] ?? '')
    if (uid && qq && uid !== qq) map.set(uid, qq)
  }
  return map.size > 0
}

/* ==================================================================
 * 群名称（对应 QQFlow export_chat.rs::load_group_names）
 * ================================================================== */

export function loadGroupNames(db: SqlDatabase): Map<string, string> {
  const map = new Map<string, string>()
  const table = findGroupInfoTable(db)
  if (!table) return map

  let columns: { name: string; type: string }[]
  try {
    columns = queryRows(db, `PRAGMA table_info(${quoteIdent(table)})`).map((r) => ({
      name: asString(r[1]),
      type: asString(r[2])
    }))
  } catch {
    return map
  }

  let gidIdx = -1
  let nameIdx = -1
  for (let i = 0; i < columns.length; i++) {
    const lower = columns[i].name.toLowerCase()
    const typeLower = columns[i].type.toLowerCase()
    if (
      gidIdx < 0 &&
      (typeLower.includes('int') ||
        lower.includes('uin') ||
        lower.includes('id') ||
        lower.includes('code') ||
        lower.includes('group'))
    ) {
      gidIdx = i
    }
    if (
      nameIdx < 0 &&
      (lower.includes('name') ||
        lower.includes('title') ||
        lower.includes('remark') ||
        typeLower.includes('text') ||
        typeLower.includes('varchar'))
    ) {
      if (gidIdx !== i) nameIdx = i
    }
  }
  if (gidIdx < 0 || nameIdx < 0) return map

  try {
    const rows = queryRows(db, `SELECT * FROM ${quoteIdent(table)} LIMIT 50000`)
    for (const r of rows) {
      const gid = asString(r[gidIdx] ?? '')
      const name = asString(r[nameIdx] ?? '')
      if (gid && name) map.set(gid, name)
    }
  } catch {
    /* 读表失败则返回已收集的部分 */
  }
  log.info('群名称加载完成', { table, 数量: map.size })
  return map
}

function findGroupInfoTable(db: SqlDatabase): string | null {
  const candidates = [
    'nt_group_info',
    'group_info',
    'troop_info',
    'nt_troop_info',
    'nt_group_table',
    'troop_member_list',
    'group_member_list',
    'recent_contact_table',
    'nt_recent_contact_table',
    'aio_recent_contact_table',
    'contact_table',
    'nt_buddylist'
  ]
  for (const name of candidates) {
    try {
      const c = asNumber(queryRows(db, `SELECT count(*) FROM ${quoteIdent(name)}`)[0]?.[0] ?? 0)
      if (c > 0) return name
    } catch {
      /* 表不存在则继续 */
    }
  }
  // 兜底：名字里含 group/troop/recent/contact/buddy 的任意表
  const fuzzy = queryRows(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND " +
      "(name LIKE '%group%' OR name LIKE '%troop%' OR name LIKE '%recent%' OR name LIKE '%contact%' OR name LIKE '%buddy%') " +
      "AND name NOT IN ('group_msg_table', 'c2c_msg_table')"
  ).map((r) => asString(r[0]))
  for (const name of fuzzy) {
    try {
      const c = asNumber(queryRows(db, `SELECT count(*) FROM ${quoteIdent(name)}`)[0]?.[0] ?? 0)
      if (c > 0) return name
    } catch {
      /* 继续 */
    }
  }
  return null
}

/* ==================================================================
 * 组装会话
 * ================================================================== */

/** 群会话：id=群号，名称优先用群名称表，最后回落到群号 */
export function listGroupConversations(
  db: SqlDatabase,
  accountId: string,
  groupNames: Map<string, string>
): Conversation[] {
  const rows = queryRows(
    db,
    'SELECT "40021", COUNT(*), MAX("40001") FROM group_msg_table GROUP BY "40021"'
  )
  const out: Conversation[] = []
  for (const r of rows) {
    const gid = asString(r[0])
    if (!gid) continue
    const count = asNumber(r[1])
    const lastTs = asNumber(r[2])
    const pid = gid
    out.push({
      id: `${accountId}:${pid}`,
      accountId,
      platform: 'qq',
      platformConversationId: pid,
      kind: 'group',
      name: groupNames.get(gid) || gid,
      lastMessageAt: normalizeTsToMs(lastTs) || undefined,
      selected: false,
      cachedMessageCount: count
    })
  }
  return out
}

/** 私聊会话：id=对端 UID，名称优先用 UID→QQ 映射的昵称/QQ 号 */
export function listC2cConversations(
  db: SqlDatabase,
  accountId: string,
  uidMap: Map<string, string>
): Conversation[] {
  const rows = queryRows(
    db,
    'SELECT "40020", COUNT(*), MAX("40001") FROM c2c_msg_table GROUP BY "40020"'
  )
  const out: Conversation[] = []
  for (const r of rows) {
    const peer = asString(r[0])
    if (!peer) continue
    const count = asNumber(r[1])
    const lastTs = asNumber(r[2])
    out.push({
      id: `${accountId}:${peer}`,
      accountId,
      platform: 'qq',
      platformConversationId: peer,
      kind: 'contact',
      name: uidMap.get(peer) || peer,
      lastMessageAt: normalizeTsToMs(lastTs) || undefined,
      selected: false,
      cachedMessageCount: count
    })
  }
  return out
}

/* ==================================================================
 * 组装消息
 * ================================================================== */

/**
 * 读某个群的最近 N 条消息（时间升序返回）。
 * SQL 用「先按时间倒序取 limit，再正序」保证拿到的是最新的一批。
 */
export function readGroupMessages(
  db: SqlDatabase,
  accountId: string,
  gid: string,
  uidMap: Map<string, string>,
  opts: ListQqMessagesOptions = {}
): ChatMessage[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 20000))
  const convId = `${accountId}:${gid}`
  const rows = queryRows(
    db,
    `SELECT "40001", "40020", "40093", "40800" FROM (
       SELECT "40001", "40020", "40093", "40800" FROM group_msg_table
       WHERE "40021" = ? ORDER BY "40001" DESC LIMIT ?
     ) ORDER BY "40001" ASC`,
    [gid, limit]
  )

  const seen = new Map<string, number>()
  const out: ChatMessage[] = []
  for (const r of rows) {
    const msgId = asNumber(r[0])
    const uid = asString(r[1])
    const nick = asString(r[2])
    const blob = asBytes(r[3])
    out.push(
      buildMessage({
        accountId,
        convId,
        platformMessageId: uniqueId(String(msgId), seen),
        senderId: uid,
        senderName: nick || uidMap.get(uid) || uid || '未知',
        timestamp: normalizeTsToMs(msgId),
        blob,
        raw: { table: 'group', gid, msgId, uid, nick }
      })
    )
  }
  return out
}

/** 读某个私聊的最近 N 条消息（时间升序） */
export function readC2cMessages(
  db: SqlDatabase,
  accountId: string,
  peer: string,
  uidMap: Map<string, string>,
  opts: ListQqMessagesOptions = {}
): ChatMessage[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 20000))
  const convId = `${accountId}:${peer}`
  const rows = queryRows(
    db,
    `SELECT "40001", "40020", "40093", "40800" FROM (
       SELECT "40001", "40020", "40093", "40800" FROM c2c_msg_table
       WHERE "40020" = ? ORDER BY "40001" DESC LIMIT ?
     ) ORDER BY "40001" ASC`,
    [peer, limit]
  )

  const seen = new Map<string, number>()
  const out: ChatMessage[] = []
  for (const r of rows) {
    const msgId = asNumber(r[0])
    const uid = asString(r[1])
    const nick = asString(r[2])
    const blob = asBytes(r[3])
    // 私聊里 40020 是对端 UID；40093 是对端昵称
    out.push(
      buildMessage({
        accountId,
        convId,
        platformMessageId: uniqueId(String(msgId), seen),
        senderId: uid,
        senderName: nick || uidMap.get(uid) || uid || '未知',
        timestamp: normalizeTsToMs(msgId),
        blob,
        raw: { table: 'c2c', peer, msgId, uid, nick }
      })
    )
  }
  return out
}

/** 同一会话里 msg_id 可能重复（QQ 的 msg_id 精度未必够），冲突时加后缀 */
function uniqueId(base: string, seen: Map<string, number>): string {
  const n = seen.get(base) ?? 0
  seen.set(base, n + 1)
  return n === 0 ? base : `${base}#${n}`
}

/** 把一行原始数据 + 解析结果组装成 ChatMessage */
function buildMessage(input: {
  accountId: string
  convId: string
  platformMessageId: string
  senderId: string
  senderName: string
  timestamp: number
  blob: Uint8Array
  raw: Record<string, unknown>
}): ChatMessage {
  let kind: ChatMessage['kind'] = 'other'
  let text = '[其他]'
  try {
    const parsed = extractText(input.blob)
    kind = qqTypeToMessageKind(parsed.msgType) as ChatMessage['kind']
    text = parsed.content
    input.raw.qqType = parsed.msgType
    input.raw.blobLength = input.blob.length
  } catch (e) {
    // 单条 BLOB 解析失败不能让整批消息崩掉
    log.warn('消息 BLOB 解析失败，按 other 处理', { id: input.platformMessageId, error: String(e) })
  }

  return {
    id: `${input.convId}:${input.platformMessageId}`,
    conversationId: input.convId,
    accountId: input.accountId,
    platformMessageId: input.platformMessageId,
    senderId: input.senderId,
    senderName: input.senderName,
    // QQFlow 读取的这几列里没有可靠的"是否本人"标志，保守地一律 false，
    // 避免把对方消息误标成自己发出的（详见回复里的"需人工确认"）。
    isSelf: false,
    kind,
    text,
    timestamp: input.timestamp,
    raw: input.raw
  }
}
