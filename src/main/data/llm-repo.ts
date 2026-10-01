/**
 * LLM 密钥仓储
 * ------------------------------------------------------------------
 * 安全约定（需求「所有敏感的且需要储存的信息，都应该进行加密」）：
 *   - API Key 用保险库加密后存 api_key_enc 列，**任何时候都不回传明文**
 *   - 对外只暴露打码后的 masked_key，界面据此展示
 */
import type { LlmKeyRecord, LlmProviderId } from '@shared/types'
import { decryptString, encryptString } from '../core/vault'
import { execute, query, queryOne } from '../core/store'
import { scoped } from '../core/logger'

const log = scoped('llm-repo')

interface KeyRow {
  provider: string
  api_key_enc: string
  masked_key: string
  model: string
  verified_at: number
  ok: number
  last_error: string | null
}

function rowToRecord(row: KeyRow): LlmKeyRecord {
  return {
    provider: row.provider as LlmProviderId,
    maskedKey: row.masked_key,
    model: row.model,
    verifiedAt: row.verified_at,
    ok: row.ok === 1,
    lastError: row.last_error ?? undefined
  }
}

/** 列出全部已保存的 Key（只含打码信息） */
export function listKeyRecords(): LlmKeyRecord[] {
  return query<KeyRow>('SELECT * FROM llm_keys ORDER BY provider ASC').map(rowToRecord)
}

export function getKeyRecord(provider: LlmProviderId): LlmKeyRecord | null {
  const row = queryOne<KeyRow>('SELECT * FROM llm_keys WHERE provider = ?', [provider])
  return row ? rowToRecord(row) : null
}

/**
 * 读取明文 API Key。
 * 只在主进程内部调用（发请求时），**绝不允许经由 IPC 返回给界面**。
 */
export function getPlainKey(provider: LlmProviderId): string | null {
  const row = queryOne<KeyRow>('SELECT * FROM llm_keys WHERE provider = ?', [provider])
  if (!row) return null
  try {
    return decryptString(row.api_key_enc)
  } catch (e) {
    log.error('API Key 解密失败（通常是换过主口令）', { provider, error: String(e) })
    return null
  }
}

/** 保存或更新 Key */
export function saveKey(params: {
  provider: LlmProviderId
  apiKey: string
  maskedKey: string
  model: string
  ok: boolean
  lastError?: string
}): LlmKeyRecord {
  const now = Date.now()
  execute(
    `INSERT INTO llm_keys (provider, api_key_enc, masked_key, model, verified_at, ok, last_error)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(provider) DO UPDATE SET
       api_key_enc = excluded.api_key_enc,
       masked_key  = excluded.masked_key,
       model       = excluded.model,
       verified_at = excluded.verified_at,
       ok          = excluded.ok,
       last_error  = excluded.last_error`,
    [
      params.provider,
      encryptString(params.apiKey),
      params.maskedKey,
      params.model,
      now,
      params.ok ? 1 : 0,
      params.lastError ?? null
    ]
  )
  log.info('已保存 LLM Key', { provider: params.provider, model: params.model, 校验通过: params.ok })
  return getKeyRecord(params.provider)!
}

/** 仅更新校验结果（测试 Key 时用） */
export function updateVerifyResult(
  provider: LlmProviderId,
  ok: boolean,
  lastError?: string
): LlmKeyRecord | null {
  const existing = getKeyRecord(provider)
  if (!existing) return null
  execute('UPDATE llm_keys SET ok = ?, verified_at = ?, last_error = ? WHERE provider = ?', [
    ok ? 1 : 0,
    Date.now(),
    lastError ?? null,
    provider
  ])
  return getKeyRecord(provider)
}

/** 切换某平台使用的模型 */
export function setModel(provider: LlmProviderId, model: string): LlmKeyRecord | null {
  const existing = getKeyRecord(provider)
  if (!existing) return null
  execute('UPDATE llm_keys SET model = ? WHERE provider = ?', [model, provider])
  log.info('已切换模型', { provider, model })
  return getKeyRecord(provider)
}

export function removeKey(provider: LlmProviderId): void {
  execute('DELETE FROM llm_keys WHERE provider = ?', [provider])
  log.info('已移除 LLM Key', { provider })
}

export function clearAllKeys(): void {
  execute('DELETE FROM llm_keys')
}
