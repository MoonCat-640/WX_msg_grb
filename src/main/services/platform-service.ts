/**
 * 平台与账号服务
 * ------------------------------------------------------------------
 * 本模块负责「平台清单」与「账号登记/管理」，是账号数据的唯一入口。
 * 上层（IPC router / 界面）只通过这里读写账号，不直接碰仓储层。
 *
 * ⚠️ 背景：本项目**不内置任何扫码登录**（给未来接手的人看）
 * ------------------------------------------------------------------
 * 更新需求 §1 已明确取消所有平台的扫码/密码登录，原因很实际：
 *   微信 / QQ / 企业微信的登录协议都是**私有协议**，要拿到它们必须逆向客户端
 *   或调用未公开的开放平台接口。我们没有、也不应该把这类实现塞进本软件——
 *   一是法律与合规风险，二是协议随时会变、维护成本极高。
 *
 * 所以「登录」在本项目里的含义被重新定义为**登记已有账号，而不是去登录**：
 *   ① 微信：`local-detect` —— 扫本机 wechat_exp 数据目录，识别出**本机已登录**的
 *      微信账号。这是真实可用、也是唯一能拿到聊天数据的那条路。
 *      （具体扫描逻辑在 sync-service.detectLocalAccounts()，本模块只做落库。）
 *   ② QQ：`manual-key` —— 用户手动登记 QQ 号，并给出 nt_msg.db 路径与数据库密钥。
 *      密钥需要注入 QQ 进程才能提取，这同样属于我们不做的事；改为：
 *        - 复用 QQFlow 已提取的密钥（%APPDATA%\qqflow\qqflow_keys.json），或
 *        - 让用户手动粘贴 16 字节密钥。
 *      密钥属于**敏感数据**，绝不写进账号表，统一交给 src/main/qq/keys.ts
 *      用加密保险库保管；本模块只负责登记账号的非敏感信息。
 *
 * 更新需求 §1 同时取消了企业微信（企业办公软件的权限与加密更复杂，暂不接入），
 * 并取消了账号数量上限（「账号多开由用户自理，我们不管了」）。
 */
import { randomUUID } from 'node:crypto'
import type { Account, PlatformDescriptor, PlatformId } from '@shared/types'
import { errors } from '../core/errors'
import { scoped } from '../core/logger'
import {
  deleteAccount as repoDeleteAccount,
  findAccount,
  insertAccount,
  listAccounts,
  listAccountsByPlatform,
  updateAccount as repoUpdateAccount
} from '../data/account-repo'

const log = scoped('platform')

/**
 * 平台清单（顺序即界面展示顺序）。
 *
 * 只保留微信与 QQ 两个平台：企业微信在更新需求 §1 中被取消。
 * `maxAccounts` 统一填 0，约定 **0 = 不限制**：
 *   更新需求 §1 原文「如果需要账号多开，就请用户自行准备多开工具，我们不管这个了」，
 *   因此这里不再对账号数量做任何校验，字段仅为兼容既有契约而保留。
 */
export const PLATFORMS: PlatformDescriptor[] = [
  {
    id: 'wechat',
    label: '微信',
    color: '#07C160',
    // 微信走本机数据目录识别，是唯一已真实打通的完整数据链路
    loginMethods: ['local-detect'],
    // 0 = 不限制账号数（更新需求 §1：多开由用户自理）
    maxAccounts: 0,
    dataSourceReady: true
  },
  {
    id: 'qq',
    label: 'QQ',
    color: '#12B7F5',
    // QQ 没有现成的本机识别工具，改为手动登记账号 + 数据库密钥
    loginMethods: ['manual-key'],
    // 0 = 不限制账号数（更新需求 §1：多开由用户自理）
    maxAccounts: 0,
    // QQ 数据读取正在接入中（QQFlow 方案），按已接入处理
    dataSourceReady: true
  }
]

export function listPlatforms(): PlatformDescriptor[] {
  return PLATFORMS.map((p) => ({ ...p }))
}

export function getPlatform(id: PlatformId): PlatformDescriptor {
  const p = PLATFORMS.find((x) => x.id === id)
  if (!p) throw errors.invalidArg(`未知平台: ${id}`)
  return p
}

/* ------------------------------------------------------------------ */
/* 账号管理                                                            */
/* ------------------------------------------------------------------ */

export function listAllAccounts(): Account[] {
  return listAccounts()
}

/**
 * 手动登记一个账号（对应 IPC 通道 `account:addManual`）。
 *
 * 用途：取消扫码登录后，QQ 靠这个入口加账号（微信仍优先用 `account:detectLocal`
 * 自动识别，但用户也可以手动登记）。
 *
 * 实现要点：
 *  - `platformAccountId` 必填，并做**同平台同账号查重**，避免重复登记。
 *  - **不做任何数量上限校验**（更新需求 §1：账号多开我们不管了）。
 *  - `dbStorageDir` 字段被**有意复用**来承载 QQ 的 nt_msg.db 路径：
 *    它本身就是「该账号的数据目录」，语义一致，复用它可避免为账号表加新列
 *    （加列要动 schema 与迁移，收益不划算）。
 *  - `key`（QQ 数据库密钥）**不写入账号表**：密钥属于敏感数据，统一由
 *    src/main/qq/keys.ts 用加密保险库存储，账号表只放非敏感信息。
 *    这里保留该参数只是为了把值透传给调用方（IPC router → QQ 模块），实现里故意忽略它。
 */
export function addManualAccount(params: {
  platform: PlatformId
  platformAccountId: string
  displayName?: string
  /** QQ 专用：nt_msg.db 的绝对路径 */
  dbPath?: string
  /** QQ 专用：16 字节数据库密钥（不填则稍后由 QQ 模块尝试复用 QQFlow 的） */
  key?: string
  note?: string
}): Account {
  const { platform, dbPath } = params

  // 平台合法性：借 getPlatform 做一次校验，未知平台直接抛错
  const descriptor = getPlatform(platform)

  const platformAccountId = params.platformAccountId?.trim()
  if (!platformAccountId) {
    throw errors.invalidArg('账号标识不能为空')
  }

  // 同平台同账号查重
  if (findAccount(platform, platformAccountId)) {
    throw errors.invalidArg('该账号已登记，无需重复添加')
  }

  const now = Date.now()
  const account: Account = {
    id: randomUUID(),
    platform,
    platformAccountId,
    displayName: params.displayName?.trim() || platformAccountId,
    state: 'online',
    loginMethod: 'manual-key',
    detectedLocally: false,
    // 有意复用 dbStorageDir 承载 QQ 的数据库路径，避免为账号表加新列
    dbStorageDir: dbPath,
    createdAt: now,
    lastSeenAt: now,
    note: params.note
  }

  // 不存 secret：密钥交给 QQ 模块的保险库，账号表只放非敏感信息
  insertAccount(account)

  log.info('手动登记账号完成', {
    platform: descriptor.label,
    platformAccountId,
    // 只记录「是否带了密钥」，密钥本身绝不落日志
    keyProvided: Boolean(params.key),
    dbPath: dbPath ?? '(未提供)'
  })
  return account
}

export function removeAccount(accountId: string): void {
  const acc = listAccounts().find((a) => a.id === accountId)
  if (!acc) throw errors.notFound('账号', accountId)
  repoDeleteAccount(accountId)
  log.info('账号已移除', { platform: acc.platform, name: acc.displayName })
}

export function updateAccount(accountId: string, patch: Partial<Account>): Account {
  return repoUpdateAccount(accountId, patch)
}

/** 平台账号数量统计（右上角账户按钮的悬浮框用）——现在只有微信与 QQ 两个平台 */
export function accountSummary(): { platform: PlatformId; label: string; color: string; count: number }[] {
  return PLATFORMS.map((p) => ({
    platform: p.id,
    label: p.label,
    color: p.color,
    count: listAccountsByPlatform(p.id).length
  }))
}
