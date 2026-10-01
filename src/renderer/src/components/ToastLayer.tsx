/**
 * 提示层（Toast）
 * ------------------------------------------------------------------
 * 所有后端错误最终都会走到这里（api.ts 的 toast/toastError）。
 * 设计要点：
 *   - 错误停留久一点（10 秒），提示类 5 秒——用户需要时间读完错误
 *   - detail（给开发者看的原始信息）默认折叠成小字，不干扰普通阅读
 *   - 最多同时显示 4 条，超出丢弃最旧的，避免刷屏遮住界面
 */
import { useEffect, useState, type JSX } from 'react'
import { onToast, type ToastPayload } from '../api'
import { Icon } from './icons'

const MAX_VISIBLE = 4
/** 各类提示的自动消失时间（毫秒） */
const TTL: Record<ToastPayload['kind'], number> = {
  info: 5000,
  ok: 4500,
  warn: 8000,
  error: 10000
}

export function ToastLayer(): JSX.Element | null {
  const [items, setItems] = useState<ToastPayload[]>([])

  useEffect(() => {
    const timers: number[] = []

    const off = onToast((t) => {
      setItems((prev) => [...prev, t].slice(-MAX_VISIBLE))
      // 到点自动移除（按 id 精确移除，避免把后来居上的同类提示误删）
      const timer = window.setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== t.id))
      }, TTL[t.kind])
      timers.push(timer)
    })

    return () => {
      off()
      // 组件卸载时清掉所有定时器，避免对已卸载组件 setState
      for (const t of timers) window.clearTimeout(t)
    }
  }, [])

  if (items.length === 0) return null

  return (
    <div className="toast-layer" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={['toast', `toast-${t.kind}`].join(' ')}>
          <span className="toast-icon">
            {t.kind === 'ok' ? (
              <Icon.CheckCircle size={16} />
            ) : t.kind === 'error' ? (
              <Icon.Warn size={16} />
            ) : t.kind === 'warn' ? (
              <Icon.Warn size={16} />
            ) : (
              <Icon.Info size={16} />
            )}
          </span>
          <span className="toast-text grow">
            <span className="toast-message">{t.message}</span>
            {t.detail && <span className="toast-detail">{t.detail}</span>}
          </span>
          <button
            type="button"
            className="icon-btn"
            title="关闭"
            style={{ width: 22, height: 22, flex: '0 0 auto' }}
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
          >
            <Icon.Close size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
