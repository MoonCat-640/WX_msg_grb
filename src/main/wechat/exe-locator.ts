/**
 * wechat_exp.exe 定位与版本探测
 * ------------------------------------------------------------------
 * 上层的两个诉求：
 *   1. 找到可执行的 wechat_exp.exe（优先用户手动指定的路径）
 *   2. 读出它的版本号，用于界面展示与「版本过低」提示
 *
 * 关于纯净性：本文件与 service.ts 允许依赖主进程的 core 模块（settings/paths），
 * 它们内部会用 electron（app.getPath 等）。除这两个文件外，wechat 这一层
 * 不引入 electron，保持可单测。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { findWechatExpCandidates } from '@main/core/paths'
import { getSettings } from '@main/core/settings'
import { scoped } from '@main/core/logger'
import type { LocateResult } from './types'

const log = scoped('wechat-exp')

/** `--version` 的硬超时（契约文档 §A.2：输出形如 "WeChat EXP 2.10.20260925"） */
const VERSION_TIMEOUT_MS = 10_000

/**
 * 从文件名里提取「日期型版本号」。
 *
 * 打包产物名形如 `wechat_exp_2.10.20260925.exe`，仓库里可能同时躺着
 * `wechat_exp_2.10.20260925_2.exe` 等多个候选。用文件名中的 8 位日期
 * （20YYMMDD）做比较，取最大者即最新版本。找不到日期则返回 -1。
 */
function extractDateRank(filePath: string): number {
  const name = basename(filePath)
  // 优先匹配 "20YYMMDD" 形式的日期；取文件名中最后一个（版本号里的日期在末尾）
  const matches = name.match(/20\d{6}/g)
  if (!matches || matches.length === 0) return -1
  const last = matches[matches.length - 1]
  const n = Number.parseInt(last, 10)
  return Number.isFinite(n) ? n : -1
}

/** 多个候选中选「文件名里日期最大」的那个；同分时保持输入顺序（稳定） */
function pickNewest(candidates: string[]): string {
  let best = candidates[0]
  let bestRank = extractDateRank(best)
  for (let i = 1; i < candidates.length; i++) {
    const rank = extractDateRank(candidates[i])
    // 严格大于才替换：保证同分时取先出现的（即 roots 顺序里更靠前的目录）
    if (rank > bestRank) {
      best = candidates[i]
      bestRank = rank
    }
  }
  return best
}

/**
 * 定位 wechat_exp.exe：
 *   1. 设置里的 wechatExpPath（必须真实存在，避免用户填了错路径后彻底找不到）
 *   2. findWechatExpCandidates() 自动搜索；多个候选取文件名日期最大的
 *   3. 都没有 → { path: '', source: 'missing' }
 */
export function locateWechatExp(): LocateResult {
  const configured = getSettings().wechatExpPath?.trim()
  if (configured) {
    if (existsSync(configured)) {
      log.info('使用设置中指定的 wechat_exp 路径', { path: configured })
      return { path: configured, source: 'settings' }
    }
    // 不直接判 missing：用户配置失效时仍尝试自动搜索，只是记一条 warn。
    log.warn('设置中的 wechat_exp 路径不存在，改走自动搜索', { configured })
  }

  const candidates = findWechatExpCandidates()
  if (candidates.length === 0) {
    log.warn('未找到 wechat_exp.exe，请将 exe 放到程序根目录或 tools 目录，或在设置中指定路径')
    return { path: '', source: 'missing' }
  }

  const picked = pickNewest(candidates)
  if (candidates.length > 1) {
    log.info('发现多个 wechat_exp 候选，已选用版本号最大者', {
      选用: basename(picked),
      候选数: candidates.length
    })
  }
  return { path: picked, source: 'auto' }
}

/**
 * 运行 `wechat_exp.exe --version` 解析版本号。
 *
 * 失败（文件不存在 / 超时 / 非零退出 / 输出无法解析）一律返回 null 并记日志，
 * 绝不让「读不到版本」阻断主流程——版本只是展示与提示用途。
 *
 * 注意：PyInstaller 单文件 exe 首次启动要解压自身，可能偏慢，故给到 10 秒。
 */
export function readVersion(exePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!exePath || !existsSync(exePath)) {
      log.warn('读取 wechat_exp 版本失败：exe 不存在', { exePath })
      resolve(null)
      return
    }
    // windowsHide：避免在用户桌面闪出一个黑框
    execFile(
      exePath,
      ['--version'],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          log.warn('读取 wechat_exp 版本失败', {
            exePath,
            错误: err.message,
            输出: (stdout || stderr || '').slice(0, 200)
          })
          resolve(null)
          return
        }
        const text = `${stdout || ''}\n${stderr || ''}`.trim()
        // 契约文档 §A.2：正常输出 "WeChat EXP 2.10.20260925"
        const m = text.match(/WeChat\s+EXP\s+([0-9][0-9.]*)/i)
        if (m) {
          resolve(m[1])
          return
        }
        // 兜底：取第一行非空文本（可能是 "WeChat EXP xxx" 之外的本地化输出）
        const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
        if (firstLine && /^[\d.]+$/.test(firstLine)) {
          resolve(firstLine)
          return
        }
        log.warn('wechat_exp --version 输出无法解析', { 输出: text.slice(0, 200) })
        resolve(null)
      }
    )
  })
}
