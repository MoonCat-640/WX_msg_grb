/**
 * 统一错误封装
 * ------------------------------------------------------------------
 * 主进程绝不把裸异常抛给渲染进程——一律转成 AppError，
 * 保证界面上永远能看到「给用户看的中文提示」+「给开发者看的细节」。
 */
import type { AppError, Result } from '@shared/types'

/** 业务错误：message 面向用户，detail 面向开发者 */
export class AppFailure extends Error {
  readonly code: string
  readonly detail?: string

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'AppFailure'
    this.code = code
    this.detail = detail
  }
}

/** 把任意异常规整成 AppError */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppFailure) {
    return { code: err.code, message: err.message, detail: err.detail }
  }
  if (err instanceof Error) {
    return {
      code: 'unexpected',
      message: '发生未预期的错误，请查看日志了解详情',
      detail: `${err.name}: ${err.message}\n${err.stack ?? ''}`.trim()
    }
  }
  return { code: 'unknown', message: '发生未知错误', detail: String(err) }
}

/** 包装成功结果 */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

/** 包装失败结果 */
export function fail<T = never>(err: unknown): Result<T> {
  return { ok: false, error: toAppError(err) }
}

/** 常用错误构造快捷方式 */
export const errors = {
  notFound: (what: string, detail?: string) => new AppFailure('not_found', `${what}不存在`, detail),
  invalidArg: (message: string, detail?: string) => new AppFailure('invalid_arg', message, detail),
  locked: (detail?: string) =>
    new AppFailure('vault_locked', '数据保险库处于锁定状态，请先解锁', detail),
  notReady: (message: string, detail?: string) => new AppFailure('not_ready', message, detail),
  io: (message: string, detail?: string) => new AppFailure('io_error', message, detail),
  external: (message: string, detail?: string) => new AppFailure('external_error', message, detail),
  timeout: (what: string, detail?: string) =>
    new AppFailure('timeout', `${what}超时，请检查网络或稍后重试`, detail)
}
