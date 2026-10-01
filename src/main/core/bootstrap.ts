/**
 * 应用状态引导
 * ------------------------------------------------------------------
 * 启动顺序（顺序不能乱，否则会读到未解密的数据库）：
 *   ① 读取 boot.json 里的非敏感设置
 *   ② 尝试用「记住的主口令」自动解锁保险库
 *   ③ 解锁成功 → 打开加密数据库 → 建表
 *   ④ 解锁失败 → 界面显示解锁页，用户输入口令后走 unlockAndOpen()
 *
 * 设计取舍：首次运行会自动生成一个随机主口令并用 Electron safeStorage
 * （Windows 下是 DPAPI，绑定当前 Windows 用户）保存，实现「无感加密」，
 * 避免用户第一次打开就被口令框挡住。用户可在「设置 → 安全」里改成自己的口令，
 * 或关闭自动解锁。
 */
import type { VaultStatus } from '@shared/types'
import { scoped } from './logger'
import { getSettings } from './settings'
import {
  generateRandomPassword,
  getVaultStatus,
  isInitialized,
  isUnlocked,
  setupVault,
  tryAutoUnlock,
  unlockVault
} from './vault'
import { isStoreOpen, openStore } from './store'

const log = scoped('bootstrap')

/** 应用启动时调用一次 */
export async function initVaultAndStore(): Promise<{ unlocked: boolean }> {
  const settings = getSettings()
  log.info('应用启动', { 模拟模式: settings.mockMode, 日志级别: settings.logLevel })

  // 首次运行：自动建立一个「无感」保险库
  if (!isInitialized()) {
    const pwd = generateRandomPassword()
    setupVault(pwd, true)
    log.info('首次运行：已自动创建加密保险库（随机主口令 + 系统凭据保护）')
  }

  const unlocked = tryAutoUnlock()
  if (unlocked) {
    await openStoreSafely()
  } else {
    log.warn('保险库未自动解锁，界面将显示解锁页')
  }
  return { unlocked }
}

/** 用户输入口令解锁后调用 */
export async function unlockAndOpen(password: string): Promise<VaultStatus> {
  const status = unlockVault(password)
  await openStoreSafely()
  return status
}

async function openStoreSafely(): Promise<void> {
  if (isStoreOpen()) return
  try {
    await openStore()
    // 打开后跑一次数据迁移（幂等）：把旧版本"软删除"的任务归入新的「已删除」分类。
    // 更新需求 §4 把删除从"置 deleted 标志"改成了"status = deleted"，
    // 不做这一步的话，旧数据里已删除的任务会在所有标签页里都看不见。
    const { migrateLegacyDeletedTasks } = await import('../data/task-repo')
    migrateLegacyDeletedTasks()
  } catch (e) {
    log.error('打开数据库失败', { error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}

/** 需要数据库的操作在入口处调用，给出明确的中文错误而不是底层异常 */
export function requireReady(): void {
  if (!isUnlocked()) {
    throw new Error('数据保险库处于锁定状态，请先解锁')
  }
  if (!isStoreOpen()) {
    throw new Error('数据库尚未初始化完成，请稍后重试')
  }
}

/** 当前是否可读写业务数据 */
export function isReady(): boolean {
  return isUnlocked() && isStoreOpen()
}

export { getVaultStatus }
