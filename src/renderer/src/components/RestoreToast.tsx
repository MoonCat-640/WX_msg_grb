/**
 * 恢复提示框（RestoreToast）
 * ------------------------------------------------------------------
 * 需求（README_UPDATE_NEW.md §4 + 边界补充）：
 *   「在页面上方中部弹出绿色提示框提示已恢复，持续时间 2 秒，有倒数进度条
 *     （跟按钮确认的条一样，不过反过来而已），且用户可以点击提示框内右上角
 *     的小叉关闭提示框。」
 *   「提示框不阻塞其他操作，用户可以继续操作界面。多个提示框同时出现时，
 *     队列显示，最多同时堆叠 3 个，超出部分等待。」
 *
 * 分工：调用方（App）只负责往 `items` 里 push 条目；本组件自己管理
 *   「最多同时 3 个」的队列与每条的 2 秒倒计时。
 *
 * 为什么进度条要「从满到空」：按钮确认条是 0 → 100% 表示"蓄力完成"，
 * 提示框是倒计时（剩余时间），方向自然相反，用 100% → 0%。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Icon } from './icons'

/** 同时最多堆叠的提示框数量：§4 边界补充原文「最多同时堆叠 3 个」 */
const MAX_VISIBLE = 3
/** 单条提示框的存活时长：§4 原文「持续时间 2 秒」 */
const TOAST_MS = 2000

export interface RestoreToastItem {
  id: number
  taskName: string
}

export interface RestoreToastLayerProps {
  items: RestoreToastItem[]
  onDismiss: (id: number) => void
}

/* ------------------------------------------------------------------ */
/* 单条提示框：自带 2 秒倒数与反向进度条                                */
/* ------------------------------------------------------------------ */

function RestoreToastCard({
  taskName,
  onClose
}: {
  taskName: string
  onClose: () => void
}): JSX.Element {
  /** 剩余比例 1 → 0（进度条宽度） */
  const [remaining, setRemaining] = useState(1)
  const rafRef = useRef<number | null>(null)
  // 用 ref 保存回调，避免父级每次渲染都重启倒计时
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const start = performance.now()
    const tick = (): void => {
      const p = 1 - (performance.now() - start) / TOAST_MS
      if (p <= 0) {
        rafRef.current = null
        setRemaining(0)
        // 到点自动消失（等价于点小叉）
        closeRef.current()
        return
      }
      setRemaining(p)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    // 审查重点：组件卸载 / 提前关闭时必须取消动画帧，否则会打到已卸载的组件上
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  return (
    <div className="restore-toast" role="status" aria-live="polite">
      <span className="restore-icon">
        <Icon.CheckCircle size={16} />
      </span>
      <span className="restore-text" title={`已恢复任务：${taskName}`}>
        已恢复任务：<strong>{taskName}</strong>
      </span>
      <button
        type="button"
        className="restore-close"
        title="关闭提示"
        aria-label="关闭提示"
        onClick={onClose}
      >
        <Icon.Close size={13} />
      </button>
      {/* 倒数进度条：从满到空 */}
      <span className="restore-bar" aria-hidden="true">
        <span className="restore-bar-fill" style={{ width: `${remaining * 100}%` }} />
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 队列层：从 items 里挑出最多 3 条显示，其余排队                        */
/* ------------------------------------------------------------------ */

export function RestoreToastLayer({ items, onDismiss }: RestoreToastLayerProps): JSX.Element | null {
  /** 当前正在显示的条目 id（按加入顺序） */
  const [visibleIds, setVisibleIds] = useState<number[]>([])
  /** 已经显示过（或被关闭）的 id，避免父级尚未移除时被重复补位 */
  const finishedRef = useRef<Set<number>>(new Set())

  // items 变化 → 剔除已移除的，并用队首的条目补满空位
  useEffect(() => {
    setVisibleIds((prev) => {
      const alive = prev.filter((id) => items.some((it) => it.id === id))
      const room = MAX_VISIBLE - alive.length
      if (room <= 0) {
        return alive.length === prev.length ? prev : alive
      }
      const admitted = items
        .filter((it) => !alive.includes(it.id) && !finishedRef.current.has(it.id))
        .slice(0, room)
        .map((it) => it.id)
      if (admitted.length === 0 && alive.length === prev.length) return prev
      return [...alive, ...admitted]
    })
  }, [items])

  const dismiss = useCallback(
    (id: number) => {
      finishedRef.current.add(id)
      // 先本地腾位，保证排队中的下一条能立刻补上（不依赖父级更新的时机）
      setVisibleIds((prev) => prev.filter((x) => x !== id))
      onDismiss(id)
    },
    [onDismiss]
  )

  if (items.length === 0) return null

  return (
    // 不阻塞操作：整层 pointer-events: none，只有单条卡片可点（见 CSS）
    <div className="restore-layer">
      {visibleIds.map((id) => {
        const item = items.find((it) => it.id === id)
        if (!item) return null
        return <RestoreToastCard key={id} taskName={item.taskName} onClose={() => dismiss(id)} />
      })}
    </div>
  )
}
