/**
 * 应用设置（boot.json）
 * ------------------------------------------------------------------
 * 这里只放「不敏感」的配置——因为保险库解锁之前就要能读到它们
 * （例如：模拟数据模式、wechat_exp 路径、同步间隔）。
 *
 * 敏感配置（LLM API Key 等）一律存在加密数据库里，见 data/llm-repo.ts。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { AppSettings, LogLevel } from '@shared/types'
import { bootConfigPath } from './paths'
import { scoped, setLogLevel } from './logger'

const log = scoped('settings')

/** 默认设置（首次运行） */
export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  mockMode: false,
  wechatExpPath: '',
  // QQFlow.exe 路径（第二次更新需求 §2/§5）：留空则自动搜索 tools\ / reference\ 等位置
  qqflowPath: '',
  dbStorageDir: '',
  /** 0 表示自动挑选空闲端口 */
  wechatExpPort: 0,
  sync: {
    /** 需求：定时轮询，默认 30 秒 */
    intervalMs: 30_000,
    enabled: true,
    lookbackDays: 30
  },
  // 托盘默认开启「关闭到托盘」但不开启后台捕获（避免用户不知情时后台跑）
  tray: {
    enabled: true,
    closeToTray: true,
    backgroundCapture: false
  },
  launchAtLogin: false,
  logLevel: 'info',
  uiScale: 1,
  ioTimeoutMs: 30_000,
  activeLlm: null
}

let cache: AppSettings | null = null

/** 深合并（只处理本配置里的一层嵌套：sync / tray） */
function merge(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const out: AppSettings = { ...base, ...patch }
  out.sync = { ...base.sync, ...(patch.sync ?? {}) }
  out.tray = { ...base.tray, ...(patch.tray ?? {}) }
  return out
}

/** 读取设置（带默认值兜底） */
export function getSettings(): AppSettings {
  if (cache) return cache
  const file = bootConfigPath()
  if (!existsSync(file)) {
    cache = { ...DEFAULT_SETTINGS }
    return cache
  }
  try {
    // 去掉 UTF-8 BOM：用记事本 / PowerShell 5.1 的 `Out-File -Encoding UTF8`
    // 保存过的文件会带 BOM，而 JSON.parse 遇到 BOM 会直接抛错。
    // 一旦抛错这里会**整体回退默认设置**，用户会莫名其妙地：
    //   失去已选的 LLM 平台（静默降级成规则抽取）、同步间隔复位……
    // 所以先剥掉 BOM，让这种"手改过配置"的情况不再引发连锁故障。
    const raw = readFileSync(file, 'utf8').replace(/^﻿/, '')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cache = merge(DEFAULT_SETTINGS, parsed)
    setLogLevel(cache.logLevel)
    return cache
  } catch (e) {
    log.error('设置文件解析失败，回退默认设置（注意：这会让 LLM 平台等配置失效）', {
      file,
      error: String(e)
    })
    cache = { ...DEFAULT_SETTINGS }
    return cache
  }
}

/** 更新设置（部分字段）并落盘 */
export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const next = merge(getSettings(), patch)
  cache = next
  setLogLevel(next.logLevel)
  const file = bootConfigPath()
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
    log.info('设置已更新', { 变更字段: Object.keys(patch) })
  } catch (e) {
    log.error('设置落盘失败', { error: String(e) })
  }
  return next
}

/** 校验日志级别取值 */
export function isLogLevel(v: unknown): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error'
}
