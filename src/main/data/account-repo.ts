/**
 * 账号仓储
 * ------------------------------------------------------------------
 * 敏感字段（登录凭据）单独用保险库加密后存入 secret 列，
 * 这样即便有人拿到数据库文件也无法直接读取。
 */
import type { Account, AccountState, LoginMethod, PlatformId } from '@shared/types'
import { decryptJson, encryptJson } from '../core/vault'
import { execute, query, queryOne, transaction } from '../core/store'
import { scoped } from '../core/logger'

const log = scoped('account-repo')

interface AccountRow {
  id: string
  platform: string
  platform_account_id: string
  display_name: string
  avatar_url: string | null
  state: string
  login_method: string
  detected_locally: number
  db_storage_dir: string | null
  note: string | null
  created_at: number
  last_seen_at: number
  secret: string | null
}

/** 账号的敏感附加信息（加密存储） */
export interface AccountSecret {
  /** 登录凭据（如 QQ 的会话票据）；微信场景通常为空 */
  credential?: string
  /** 登录时的原始二维码内容（便于排查） */
  qrContent?: string
  /** 其他平台相关数据 */
  extra?: Record<string, unknown>
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    platform: row.platform as PlatformId,
    platformAccountId: row.platform_account_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? undefined,
    state: row.state as AccountState,
    loginMethod: row.login_method as LoginMethod,
    detectedLocally: row.detected_locally === 1,
    dbStorageDir: row.db_storage_dir ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  }
}

export function listAccounts(): Account[] {
  return query<AccountRow>('SELECT * FROM accounts ORDER BY created_at ASC').map(rowToAccount)
}

export function listAccountsByPlatform(platform: PlatformId): Account[] {
  return query<AccountRow>('SELECT * FROM accounts WHERE platform = ? ORDER BY created_at ASC', [
    platform
  ]).map(rowToAccount)
}

export function getAccount(id: string): Account | null {
  const row = queryOne<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id])
  return row ? rowToAccount(row) : null
}

/** 按「平台 + 平台账号 id」查重，避免同一账号被重复登记 */
export function findAccount(platform: PlatformId, platformAccountId: string): Account | null {
  const row = queryOne<AccountRow>(
    'SELECT * FROM accounts WHERE platform = ? AND platform_account_id = ?',
    [platform, platformAccountId]
  )
  return row ? rowToAccount(row) : null
}

export function insertAccount(account: Account, secret?: AccountSecret): Account {
  const secretEnc = secret ? encryptJson(secret) : null
  execute(
    `INSERT INTO accounts
      (id, platform, platform_account_id, display_name, avatar_url, state, login_method,
       detected_locally, db_storage_dir, note, created_at, last_seen_at, secret)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      account.id,
      account.platform,
      account.platformAccountId,
      account.displayName,
      account.avatarUrl ?? null,
      account.state,
      account.loginMethod,
      account.detectedLocally ? 1 : 0,
      account.dbStorageDir ?? null,
      account.note ?? null,
      account.createdAt,
      account.lastSeenAt,
      secretEnc
    ]
  )
  log.info('已登记账号', { platform: account.platform, name: account.displayName })
  return account
}

/** 更新账号（只更新传入的字段） */
export function updateAccount(id: string, patch: Partial<Account>): Account {
  const current = getAccount(id)
  if (!current) throw new Error(`账号不存在: ${id}`)
  const next: Account = { ...current, ...patch, id }
  execute(
    `UPDATE accounts SET platform = ?, platform_account_id = ?, display_name = ?, avatar_url = ?,
       state = ?, login_method = ?, detected_locally = ?, db_storage_dir = ?, note = ?,
       last_seen_at = ? WHERE id = ?`,
    [
      next.platform,
      next.platformAccountId,
      next.displayName,
      next.avatarUrl ?? null,
      next.state,
      next.loginMethod,
      next.detectedLocally ? 1 : 0,
      next.dbStorageDir ?? null,
      next.note ?? null,
      next.lastSeenAt,
      id
    ]
  )
  return next
}

/** 读取账号的敏感信息（需保险库已解锁） */
export function getAccountSecret(id: string): AccountSecret | null {
  const row = queryOne<{ secret: string | null }>('SELECT secret FROM accounts WHERE id = ?', [id])
  if (!row?.secret) return null
  try {
    return decryptJson<AccountSecret>(row.secret)
  } catch (e) {
    log.warn('账号凭据解密失败（可能换了主口令）', { id, error: String(e) })
    return null
  }
}

export function setAccountSecret(id: string, secret: AccountSecret): void {
  execute('UPDATE accounts SET secret = ? WHERE id = ?', [encryptJson(secret), id])
}

/** 删除账号，并级联清理其会话与消息（任务数据保留，因为可能已合并多来源） */
export function deleteAccount(id: string): void {
  transaction(() => {
    execute('DELETE FROM messages WHERE account_id = ?', [id])
    execute('DELETE FROM conversations WHERE account_id = ?', [id])
    execute('DELETE FROM accounts WHERE id = ?', [id])
  })
  log.info('已删除账号及其会话缓存', { id })
}

export function countByPlatform(): Record<string, number> {
  const rows = query<{ platform: string; n: number }>(
    'SELECT platform, COUNT(*) AS n FROM accounts GROUP BY platform'
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.platform] = r.n
  return out
}
