/**
 * 本地数据库（SQLite via sql.js）
 * ------------------------------------------------------------------
 * 为什么选 sql.js：
 *   - 纯 WASM 实现，无需在用户机器上编译原生模块（Windows 上最稳）
 *   - 数据以内存数据库形式存在，落盘时整库序列化后 AES-256-GCM 加密
 *     —— 直接满足需求「数据库文件加密，防止外部读取」
 *
 * 落盘策略：
 *   - 写操作后调用 persistSoon()，1.5 秒防抖合并；退出前调用 persistNow() 强制落盘
 *   - 原子写：先写 .tmp 再 rename，避免崩溃时留下半截文件
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Database as SqlDatabase, SqlJsStatic } from 'sql.js'
import { scoped } from './logger'
import { getAppPaths, storeFilePath } from './paths'
import { decryptBuffer, encryptBuffer, isUnlocked } from './vault'

const log = scoped('store')
const nodeRequire = createRequire(__filename)

let SQL: SqlJsStatic | null = null
let db: SqlDatabase | null = null
let saveTimer: NodeJS.Timeout | null = null
let dirty = false
let lastPersistAt = 0

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/** 定位 sql-wasm.wasm（三种位置依次尝试） */
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

let wasmBinaryCache: Buffer | null = null

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (SQL) return SQL
  const initSqlJs = nodeRequire('sql.js') as (cfg?: {
    wasmBinary?: Buffer
    locateFile?: (f: string) => string
  }) => Promise<SqlJsStatic>

  const wasmPath = locateWasm()
  if (!wasmBinaryCache) wasmBinaryCache = readFileSync(wasmPath)
  log.info('加载 SQLite WASM 引擎', { wasmPath })
  SQL = await initSqlJs({ wasmBinary: wasmBinaryCache })
  return SQL
}

/** 建表语句（每次启动都执行，IF NOT EXISTS 保证幂等） */
const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 通用键值表：应用设置、同步状态等
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 平台账号（secret 字段单独加密）
CREATE TABLE IF NOT EXISTS accounts (
  id                    TEXT PRIMARY KEY,
  platform              TEXT NOT NULL,
  platform_account_id   TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  avatar_url            TEXT,
  state                 TEXT NOT NULL DEFAULT 'offline',
  login_method          TEXT NOT NULL DEFAULT 'local-detect',
  detected_locally      INTEGER NOT NULL DEFAULT 0,
  db_storage_dir        TEXT,
  note                  TEXT,
  created_at            INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  secret                TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);

-- 会话（联系人 / 群聊）
CREATE TABLE IF NOT EXISTS conversations (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL,
  platform                  TEXT NOT NULL,
  platform_conversation_id  TEXT NOT NULL,
  kind                      TEXT NOT NULL,
  name                      TEXT NOT NULL,
  remark                    TEXT,
  nickname                  TEXT,
  member_count              INTEGER,
  last_message_at           INTEGER,
  selected                  INTEGER NOT NULL DEFAULT 0,
  cached_count              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_account ON conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_conv_selected ON conversations(selected);

-- 聊天消息缓存
CREATE TABLE IF NOT EXISTS messages (
  id                    TEXT PRIMARY KEY,
  conversation_id       TEXT NOT NULL,
  account_id            TEXT NOT NULL,
  platform_message_id   TEXT NOT NULL,
  sender_id             TEXT,
  sender_name           TEXT,
  is_self               INTEGER NOT NULL DEFAULT 0,
  kind                  TEXT NOT NULL,
  text                  TEXT,
  media_path            TEXT,
  timestamp             INTEGER NOT NULL,
  -- 消息携带的文件/链接附件（含抓取到的正文），JSON Attachment[]
  -- 修复：此前没有这一列，enrich 读到的文件/网页正文在入库时被丢弃，
  --       导致后续抽取任务时模型完全看不到附件内容（更新需求 §2.1 失效）。
  attachments           TEXT,
  raw                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_ts ON messages(conversation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp);

-- 任务
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  topic               TEXT,
  type                TEXT,
  organizers          TEXT,           -- JSON string[]
  start_at            INTEGER,
  end_at              INTEGER,
  materials           TEXT,           -- JSON TaskMaterial[]
  contact_person      TEXT,
  original_text       TEXT,
  publishers          TEXT,           -- JSON TaskPublisher[]
  source_message_ids  TEXT,           -- JSON string[]
  status              TEXT NOT NULL,
  status_locked       INTEGER NOT NULL DEFAULT 0,
  deleted             INTEGER NOT NULL DEFAULT 0,
  tile_order          INTEGER NOT NULL DEFAULT 0,
  fingerprint         TEXT,
  confidence          REAL,
  origin              TEXT NOT NULL DEFAULT 'auto',  -- 任务来源：auto（自动抽取）/ manual（用户新建）
  llm_provider        TEXT,
  llm_model           TEXT,
  llm_extracted_at    INTEGER,
  llm_batch_id        TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_fp ON tasks(fingerprint);

-- 磁贴拖拽后的布局
CREATE TABLE IF NOT EXISTS tile_layouts (
  task_id TEXT PRIMARY KEY,
  status  TEXT NOT NULL,
  col     INTEGER NOT NULL,
  row     INTEGER NOT NULL
);

-- LLM Key（api_key 字段加密）
CREATE TABLE IF NOT EXISTS llm_keys (
  provider    TEXT PRIMARY KEY,
  api_key_enc TEXT NOT NULL,
  masked_key  TEXT NOT NULL,
  model       TEXT NOT NULL,
  verified_at INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- 任务抽取批次记录
CREATE TABLE IF NOT EXISTS extraction_runs (
  id           TEXT PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  conversations INTEGER NOT NULL DEFAULT 0,
  messages      INTEGER NOT NULL DEFAULT 0,
  created       INTEGER NOT NULL DEFAULT 0,
  merged        INTEGER NOT NULL DEFAULT 0,
  failures      TEXT
);
`

/**
 * 打开数据库（需要保险库已解锁）。
 * 首次运行会创建空库。
 */
export async function openStore(): Promise<void> {
  if (db) return
  if (!isUnlocked()) {
    throw new Error('保险库未解锁，无法打开数据库')
  }
  const sql = await loadSqlJs()
  const file = storeFilePath()

  if (existsSync(file)) {
    try {
      const enc = readFileSync(file)
      const plain = decryptBuffer(enc)
      db = new sql.Database(new Uint8Array(plain))
      log.info('已解密并打开本地数据库', { file, sizeKB: Math.round(enc.length / 1024) })
    } catch (e) {
      // 解密失败：备份坏文件后新建，避免用户彻底打不开
      const broken = `${file}.broken-${Date.now()}`
      try {
        renameSync(file, broken)
      } catch {
        /* 备份失败也继续 */
      }
      log.error('数据库解密失败，已备份原文件并新建空库', { broken, error: String(e) })
      db = new sql.Database()
    }
  } else {
    db = new sql.Database()
    log.info('首次运行，创建新的本地数据库')
  }

  db.run(SCHEMA)
  runMigrations()
  markDirty()
  await persistNow()
}

/* ------------------------------------------------------------------ */
/* 轻量迁移                                                            */
/* ------------------------------------------------------------------ */

/**
 * 为「已存在的老库」补齐新增列。
 *
 * 为什么需要：SCHEMA 用的是 `CREATE TABLE IF NOT EXISTS`，对**已存在的表**
 * 它不会补列，所以新增字段必须在启动时用 ALTER TABLE 手动加。
 * sql.js 没有迁移框架，这里用 `PRAGMA table_info` 判断列是否已存在——
 * 幂等，列已存在时什么都不做，每次启动跑一遍没有副作用。
 */
function columnExists(table: string, column: string): boolean {
  const rows = query<{ name: string }>(`PRAGMA table_info(${table})`)
  return rows.some((r) => r.name === column)
}

function runMigrations(): void {
  // 第二次更新需求 §1：任务来源（auto=自动抽取 / manual=用户新建）
  if (!columnExists('tasks', 'origin')) {
    execute(`ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto'`)
    log.info('数据库迁移：tasks 表新增 origin 列（默认 auto）')
  }

  // 修复：messages 表此前没有 attachments 列，enrich 抓到的文件/网页正文
  // 在 insertMessages 时被静默丢弃，模型因此看不到附件内容。
  if (!columnExists('messages', 'attachments')) {
    execute(`ALTER TABLE messages ADD COLUMN attachments TEXT`)
    log.info('数据库迁移：messages 表新增 attachments 列（保存文件/链接正文）')
  }
}

/** 关闭数据库（退出前调用） */
export async function closeStore(): Promise<void> {
  await persistNow()
  if (db) {
    db.close()
    db = null
  }
}

/** 取数据库句柄；未打开则抛错 */
export function getDb(): SqlDatabase {
  if (!db) throw new Error('数据库尚未打开')
  return db
}

export function isStoreOpen(): boolean {
  return db !== null
}

/* ------------------------------------------------------------------ */
/* 查询辅助                                                            */
/* ------------------------------------------------------------------ */

type Param = string | number | null | Uint8Array

/** 查询多行，返回普通对象数组 */
export function query<T = Record<string, unknown>>(sql: string, params: Param[] = []): T[] {
  const stmt = getDb().prepare(sql)
  try {
    stmt.bind(params)
    const rows: T[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T)
    }
    return rows
  } finally {
    stmt.free()
  }
}

/** 查询单行 */
export function queryOne<T = Record<string, unknown>>(sql: string, params: Param[] = []): T | null {
  const rows = query<T>(sql, params)
  return rows.length > 0 ? rows[0] : null
}

/** 执行写操作 */
export function execute(sql: string, params: Param[] = []): void {
  getDb().run(sql, params)
  markDirty()
}

/** 在一个事务里执行多条（失败自动回滚） */
export function transaction<T>(fn: () => T): T {
  const database = getDb()
  database.run('BEGIN')
  try {
    const result = fn()
    database.run('COMMIT')
    markDirty()
    return result
  } catch (e) {
    try {
      database.run('ROLLBACK')
    } catch {
      /* 回滚失败则忽略，抛出原始异常 */
    }
    throw e
  }
}

/* ------------------------------------------------------------------ */
/* 落盘                                                                */
/* ------------------------------------------------------------------ */

function markDirty(): void {
  dirty = true
}

/** 防抖落盘：写操作后调用，避免频繁全库加密 */
export function persistSoon(delayMs = 1500): void {
  if (!db) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void persistNow()
  }, delayMs)
}

/** 立即落盘（原子写） */
export async function persistNow(): Promise<void> {
  if (!db || !dirty) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const start = Date.now()
  try {
    const bytes = Buffer.from(db.export())
    const enc = encryptBuffer(bytes)
    const file = storeFilePath()
    const tmp = `${file}.tmp`
    writeFileSync(tmp, enc)
    renameSync(tmp, file)
    dirty = false
    lastPersistAt = Date.now()
    log.debug('数据库已加密落盘', {
      明文KB: Math.round(bytes.length / 1024),
      密文KB: Math.round(enc.length / 1024),
      耗时ms: Date.now() - start
    })
  } catch (e) {
    log.error('数据库落盘失败', { error: e instanceof Error ? e.message : String(e) })
    // 落盘失败保留 dirty 标记，下次重试
    dirty = true
  }
}

/** 删除数据库文件（「清空全部数据」用） */
export function destroyStoreFile(): void {
  const file = storeFilePath()
  if (existsSync(file)) unlinkSync(file)
}

export function getLastPersistAt(): number {
  return lastPersistAt
}
