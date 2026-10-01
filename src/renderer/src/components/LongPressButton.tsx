/**
 * 长按按钮
 * ------------------------------------------------------------------
 * 需求原文：
 *   「无论按下哪个按键，都需要长按 2.5 秒方可真正生效，会显示进度条
 *     （参考游戏《战锤40,000:星际战士2》中购买物品的进度条）」
 *
 * 交互细节（这些细节决定「手感」，不是可有可无的）：
 *   - 按下后进度在 2500ms 内线性铺满；铺满瞬间触发回调
 *   - 中途松手 / 鼠标移出 / 指针被系统取消 → 进度立即归零（不给"差一点点"的侥幸）
 *   - 用 requestAnimationFrame 驱动，保证进度条与实际时间同步（setInterval 会漂移）
 *   - 长按期间按住不放继续拖拽鼠标不会中断（只有离开按钮区域才中断）
 *   - 键盘可访问：聚焦后按住空格/回车同样可以触发长按
 */
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'

export interface LongPressButtonProps {
  /** 长按达成的回调 */
  onComplete: () => void
  /** 长按时长（毫秒），需求为 2500 */
  durationMs?: number
  className?: string
  title?: string
  disabled?: boolean
  children: ReactNode
  /** 进度条颜色，默认取 currentColor */
  color?: string
}

export function LongPressButton({
  onComplete,
  durationMs = 2500,
  className,
  title,
  disabled,
  children,
  color
}: LongPressButtonProps): JSX.Element {
  const [progress, setProgress] = useState(0)
  const holdingRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)
  // 用 ref 保存回调，避免每次渲染都重建监听
  const completeRef = useRef(onComplete)
  completeRef.current = onComplete

  const stop = useCallback((reset = true) => {
    holdingRef.current = false
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (reset) setProgress(0)
  }, [])

  const tick = useCallback(() => {
    if (!holdingRef.current) return
    const elapsed = performance.now() - startRef.current
    const p = Math.min(1, elapsed / durationMs)
    setProgress(p)

    if (p >= 1) {
      // 先停掉计时再回调，避免回调里触发的重渲染与动画互相打架
      holdingRef.current = false
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      setProgress(0)
      completeRef.current()
      return
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [durationMs])

  const start = useCallback(() => {
    if (disabled || holdingRef.current) return
    holdingRef.current = true
    startRef.current = performance.now()
    setProgress(0)
    rafRef.current = requestAnimationFrame(tick)
  }, [disabled, tick])

  // 组件卸载时必须停掉动画，否则回调可能打到已卸载的组件上
  useEffect(() => stop, [stop])

  return (
    <button
      type="button"
      className={[
        className ?? '',
        progress > 0 ? 'is-holding' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      title={title ?? `按住 ${(durationMs / 1000).toFixed(1)} 秒生效`}
      disabled={disabled}
      // 用 pointer 事件统一处理鼠标/触摸/触控笔
      onPointerDown={(e) => {
        // 阻止默认行为，避免长按选中文字或触发原生拖拽
        e.preventDefault()
        // 捕获指针：即使指针移出按钮，我们仍能收到 up 事件
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 某些环境不支持捕获，忽略即可 */
        }
        start()
      }}
      onPointerUp={() => stop()}
      onPointerCancel={() => stop()}
      onPointerLeave={() => {
        // 长按期间鼠标移出按钮 → 视为放弃（符合"按住不放"的直觉）
        if (holdingRef.current) stop()
      }}
      // 键盘可达：空格/回车按住同样计数
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          start()
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop()
      }}
      // 禁止长按弹出右键菜单（会打断长按体验）
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 顶部细进度线：即使按钮很矮也能看清进度 */}
      <span className="tile-action-hint">
        <span
          className="tile-action-hint-fill"
          style={{ width: `${progress * 100}%`, color: color ?? 'currentColor' }}
        />
      </span>
      {/* 主体填充进度：铺满即生效 */}
      <span
        className="tile-action-fill"
        style={{ width: `${progress * 100}%`, color: color ?? 'currentColor' }}
      />
      {children}
    </button>
  )
}
