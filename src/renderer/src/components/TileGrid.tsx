/**
 * 磁贴网格（可拖拽 + 网格吸附 + 长按进多选）
 * ------------------------------------------------------------------
 * 需求原文：
 *   「磁贴可以拖动，但放置有网格（类似 Windows10 开始菜单动态磁贴的交互方式）」
 *   README_UPDATE_NEW.md §3：长按磁贴进入多选模式；多选模式下禁用拖拽。
 *   README_UPDATE_NEW.md §4：已删除分类里长按磁贴 → 二次确认 → 彻底删除。
 *
 * 实现要点（为什么这么写）：
 *   1. **绝对定位 + 自己算坐标**：磁贴位置完全由 (col,row) 决定，
 *      不用 CSS Grid 的自动流——自动流在拖拽换位时会连带重排一大片。
 *   2. **超过 5px 位移才判定为拖动**：否则用户想点开详情却总是触发拖动。
 *   3. **落点被占用就交换**：比"推挤重排"更可预测，也更接近 Win10 的手感。
 *   4. **坐标要持久化**：用户整理过的布局不能因为切个类别再回来就丢。
 *   5. **列数变化要重新收敛**：窗口变窄时原本落在右侧的磁贴必须被拉回可视范围。
 *   6. **拖动期间磁贴用 transform 跟随指针**：位置仍按格坐标，避免来回抖动。
 *   7. **手势状态机合并在一处**：pointerdown 后既可能是「拖动」也可能是「长按」，
 *      两者共用同一套 window 监听，靠"是否越过位移阈值"分叉，不会互相打架。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react'
import type { Task, TileLayout, TaskStatus } from '@shared/types'
import { TaskTile, tileSpan, type TileMode } from './TaskTile'
import { Button, Modal } from './primitives'
import { Icon } from './icons'

/** 拖动判定阈值（像素）：小于它视为点击 */
const DRAG_THRESHOLD = 5

/**
 * 长按磁贴的识别时长（毫秒）。
 * 需求没有规定进入多选的长按时长，这里取 0.5s —— 与主流手机相册一致的手感。
 * 注意它与「操作确认时长」（完成/删除 1.5s、一键清除 2.5s、已删除清除 3s）不是一回事：
 * 那些是"按住多久才生效"，这里是"按住多久算长按"，两者互不复用。
 */
const LONG_PRESS_MS = 500

interface Pos {
  col: number
  row: number
}

interface Span {
  w: number
  h: number
}

interface DragState {
  taskId: string
  pointerId: number
  /** 按下时的指针位置，用于判断是否越过拖动阈值 */
  startX: number
  startY: number
  /** 按下时指针在磁贴内的偏移，保证拖动时磁贴不"跳"到指针左上角 */
  offsetX: number
  offsetY: number
  /** 网格容器在按下时的视口位置（缓存起来，避免每次 move 都读布局） */
  gridLeft: number
  gridTop: number
  origin: Pos
  span: Span
  /** 当前吸附到的目标格 */
  target: Pos
  moved: boolean
}

export interface TileGridProps {
  tasks: Task[]
  layouts: TileLayout[]
  /** 当前分类，决定磁贴的可选操作 */
  mode: TileMode
  /** 是否处于多选模式 */
  selectionMode: boolean
  /** 已选中的任务 id 集合 */
  selectedIds: Set<string>
  onToggleSelect: (taskId: string) => void
  /** 进入多选模式（长按磁贴触发） */
  onEnterSelection: (taskId: string) => void
  onOpen: (task: Task) => void
  onComplete: (task: Task) => void
  /** 删除 = 移入已删除分类 */
  onDelete: (task: Task) => void
  /** 从已删除恢复（点击即生效） */
  onRestore: (task: Task) => void
  /** 彻底删除（已删除分类里长按触发，需二次确认） */
  onPurge: (task: Task) => void
  onLayoutChange: (layouts: TileLayout[]) => void
}

/** 两个矩形是否重叠 */
function overlaps(a: Pos, as: Span, b: Pos, bs: Span): boolean {
  return a.col < b.col + bs.w && b.col < a.col + as.w && a.row < b.row + bs.h && b.row < a.row + as.h
}

/**
 * 自动排版：给还没有位置的磁贴找第一个能放下的空格。
 * 扫描顺序是「从上到下、从左到右」，这样新增任务会自然出现在末尾。
 */
function autoPack(
  order: string[],
  spans: Record<string, Span>,
  columns: number,
  seed: Record<string, Pos>
): Record<string, Pos> {
  const result: Record<string, Pos> = { ...seed }

  let maxRow = 0
  for (const id of Object.keys(result)) {
    const p = result[id]
    maxRow = Math.max(maxRow, p.row + (spans[id]?.h ?? 1))
  }

  for (const id of order) {
    if (result[id]) continue
    const span = spans[id] ?? { w: 1, h: 1 }
    let placed = false

    // 上界给宽一点，保证一定能放下（最坏情况就是新起一行）
    for (let row = 0; row <= maxRow + 1 && !placed; row++) {
      for (let col = 0; col + span.w <= columns; col++) {
        const candidate: Pos = { col, row }
        const clash = Object.keys(result).some((other) =>
          overlaps(candidate, span, result[other], spans[other] ?? { w: 1, h: 1 })
        )
        if (!clash) {
          result[id] = candidate
          maxRow = Math.max(maxRow, row + span.h)
          placed = true
          break
        }
      }
    }

    if (!placed) {
      // 理论上不会走到这里；真发生了就顺延到下一行，保证不丢磁贴
      result[id] = { col: 0, row: maxRow }
      maxRow += span.h
    }
  }
  return result
}

/** 把坐标按新列数收敛回可视范围 */
function clampToColumns(
  positions: Record<string, Pos>,
  spans: Record<string, Span>,
  columns: number
): Record<string, Pos> {
  const out: Record<string, Pos> = {}
  for (const id of Object.keys(positions)) {
    const p = positions[id]
    const span = spans[id] ?? { w: 1, h: 1 }
    out[id] = {
      col: Math.max(0, Math.min(p.col, Math.max(0, columns - span.w))),
      row: Math.max(0, p.row)
    }
  }
  return out
}

export function TileGrid({
  tasks,
  layouts,
  mode,
  selectionMode,
  selectedIds,
  onToggleSelect,
  onEnterSelection,
  onOpen,
  onComplete,
  onDelete,
  onRestore,
  onPurge,
  onLayoutChange
}: TileGridProps): JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)

  /* ---------- 网格几何：单元格尺寸与列数 ---------- */
  const [cell, setCell] = useState(168)
  const [gap, setGap] = useState(14)
  const [columns, setColumns] = useState(4)

  // 单元格尺寸从 CSS 变量读（这样 --ui-scale 的缩放会自动生效，不用两处维护）
  useLayoutEffect(() => {
    const readGeometry = (): void => {
      const cs = getComputedStyle(document.documentElement)
      const size = parseFloat(cs.getPropertyValue('--tile-size')) || 168
      const g = parseFloat(cs.getPropertyValue('--tile-gap')) || 14
      setCell(size)
      setGap(g)

      const width = gridRef.current?.clientWidth ?? 0
      // 列数 = (可用宽度 + 间距) / (单元 + 间距)，向下取整，至少 1 列
      setColumns(Math.max(1, Math.floor((width + g) / (size + g))))
    }

    readGeometry()
    const ro = new ResizeObserver(readGeometry)
    if (gridRef.current) ro.observe(gridRef.current)
    // 界面缩放变化时也要重算（--ui-scale 挂在 <html> 的 data 属性上）
    const mo = new MutationObserver(readGeometry)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-scale'] })
    window.addEventListener('resize', readGeometry)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', readGeometry)
    }
  }, [])

  /* ---------- 尺寸与顺序 ---------- */
  const spans = useMemo(() => {
    const out: Record<string, Span> = {}
    for (const t of tasks) out[t.id] = tileSpan(t)
    return out
  }, [tasks])

  const order = useMemo(
    () => [...tasks].sort((a, b) => a.tileOrder - b.tileOrder).map((t) => t.id),
    [tasks]
  )

  const [positions, setPositions] = useState<Record<string, Pos>>({})

  // 任务集合 / 列数 / 已保存布局变化 → 重新计算位置
  useEffect(() => {
    const saved: Record<string, Pos> = {}
    for (const l of layouts) {
      if (spans[l.taskId]) saved[l.taskId] = { col: l.col, row: l.row }
    }
    const clamped = clampToColumns(saved, spans, columns)
    setPositions(autoPack(order, spans, columns, clamped))
  }, [layouts, spans, order, columns])

  /* ---------- 拖动 ---------- */
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  /**
   * 抑制"刚刚完成了一次拖动/长按"之后紧跟的那次 click。
   * 否则拖完磁贴会顺手弹出详情、长按进多选会立刻被 click 反选掉。
   */
  const suppressClickRef = useRef(false)

  const applyDrag = useCallback((next: DragState | null) => {
    dragRef.current = next
    setDrag(next)
  }, [])

  /* ---------- 长按（进多选 / 彻底删除） ---------- */
  const longPressTimerRef = useRef<number | null>(null)
  /** 本次手势是否已经被长按消费（用于在 pointerup 时抑制 click） */
  const longPressFiredRef = useRef(false)
  /** 已删除分类里等待二次确认的任务 */
  const [purgeTarget, setPurgeTarget] = useState<Task | null>(null)

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  // 卸载时必须清掉未触发的长按定时器（审查重点：定时器要清理）
  useEffect(() => clearLongPressTimer, [clearLongPressTimer])

  // 切入多选模式后，之前挂起的"长按进多选"定时器已无意义，直接取消
  useEffect(() => {
    if (selectionMode) clearLongPressTimer()
  }, [selectionMode, clearLongPressTimer])

  const handleDragStart = useCallback(
    (task: Task, e: React.PointerEvent<HTMLDivElement>) => {
      // 只响应左键；右键留给未来的上下文菜单
      if (e.button !== 0) return
      // §3：多选模式下禁用拖拽。否则"按住磁贴"会同时是拖拽预备与点选，
      // 手势语义冲突（拖一下就把选中项换了位置，很糟糕）。
      if (selectionMode) return

      const gridRect = gridRef.current?.getBoundingClientRect()
      if (!gridRect) return

      // 拖动时禁止文本选中，否则会拖出一片蓝色选区
      e.preventDefault()

      const tileRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const origin = positions[task.id] ?? { col: 0, row: 0 }

      applyDrag({
        taskId: task.id,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        offsetX: e.clientX - tileRect.left,
        offsetY: e.clientY - tileRect.top,
        gridLeft: gridRect.left,
        gridTop: gridRect.top,
        origin,
        span: spans[task.id] ?? { w: 1, h: 1 },
        target: origin,
        moved: false
      })

      // 底部操作按钮 / 复选框上的按下不算「长按磁贴」：
      // 用户是在按按钮（自己的长按进度条会处理），不能顺带触发进多选或彻底删除。
      const onControl = Boolean((e.target as HTMLElement).closest('.tile-actions, .sel-check'))
      if (onControl) return

      clearLongPressTimer()
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null
        longPressFiredRef.current = true
        if (mode === 'deleted') {
          // §4 边界：已删除分类里长按磁贴 → 弹二次确认后再彻底删除
          setPurgeTarget(task)
        } else {
          // §3：长按磁贴进入多选模式（并选中当前这一个，交给上层决定）
          onEnterSelection(task.id)
        }
      }, LONG_PRESS_MS)
    },
    [
      positions,
      spans,
      applyDrag,
      selectionMode,
      mode,
      onEnterSelection,
      clearLongPressTimer
    ]
  )

  // 全局监听 move/up：指针可能移到磁贴之外，必须挂在 window 上
  useEffect(() => {
    if (!drag) return
    const unit = cell + gap

    const onMove = (e: PointerEvent): void => {
      const cur = dragRef.current
      if (!cur || e.pointerId !== cur.pointerId) return

      // 长按已经消费了这次手势：后续移动不再当作拖动（多数情况下长按期间指针没移动）
      if (longPressFiredRef.current) return

      // 是否越过拖动阈值（用按下点到当前点的直线距离判断，比逐轴判断更符合直觉）
      const moved =
        cur.moved ||
        Math.hypot(e.clientX - cur.startX, e.clientY - cur.startY) > DRAG_THRESHOLD

      // 一旦确认是拖动，就取消挂起的长按（拖动与长按互斥）
      if (moved && !cur.moved) clearLongPressTimer()

      // 指针在磁贴内的偏移 → 推出磁贴左上角 → 四舍五入到最近格
      const localX = e.clientX - cur.gridLeft - cur.offsetX
      const localY = e.clientY - cur.gridTop - cur.offsetY
      const maxCol = Math.max(0, columns - cur.span.w)
      const target: Pos = {
        col: Math.max(0, Math.min(Math.round(localX / unit), maxCol)),
        row: Math.max(0, Math.round(localY / unit))
      }

      if (moved !== cur.moved || target.col !== cur.target.col || target.row !== cur.target.row) {
        applyDrag({ ...cur, target, moved })
      }
    }

    const onUp = (e: PointerEvent): void => {
      const cur = dragRef.current
      const longPressed = longPressFiredRef.current
      longPressFiredRef.current = false
      clearLongPressTimer()
      applyDrag(null)

      if (longPressed) {
        // 长按已经处理完毕（进多选 / 打开二次确认），压掉紧随其后的 click 后收工
        suppressClickRef.current = true
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
        return
      }

      if (!cur || e.pointerId !== cur.pointerId || !cur.moved) return

      // 抑制这次拖动后紧跟的 click
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)

      // 落点上已有的磁贴（第一个重叠的），用于交换
      const occupant = Object.keys(positions).find(
        (id) =>
          id !== cur.taskId &&
          overlaps(cur.target, cur.span, positions[id], spans[id] ?? { w: 1, h: 1 })
      )

      const next: Record<string, Pos> = { ...positions, [cur.taskId]: cur.target }

      if (occupant) {
        const occSpan = spans[occupant] ?? { w: 1, h: 1 }
        // 尺寸相同且原位置放得下 → 直接互换；否则把对方挪到第一个空格
        const canSwap =
          cur.span.w === occSpan.w &&
          cur.span.h === occSpan.h &&
          cur.origin.col + occSpan.w <= columns &&
          !Object.keys(positions).some(
            (id) =>
              id !== occupant &&
              id !== cur.taskId &&
              overlaps(cur.origin, occSpan, positions[id], spans[id] ?? { w: 1, h: 1 })
          )

        if (canSwap) {
          next[occupant] = cur.origin
        } else {
          const rest = Object.fromEntries(
            Object.entries(next).filter(([id]) => id !== occupant)
          )
          const repacked = autoPack([occupant], spans, columns, rest)
          next[occupant] = repacked[occupant] ?? { col: 0, row: 0 }
        }
      }

      setPositions(next)
      // 坐标持久化：只上报当前类别里这批任务的位置
      onLayoutChange(
        Object.entries(next).map(([taskId, p]) => ({
          taskId,
          status: tasks.find((t) => t.id === taskId)?.status ?? ('ongoing' as TaskStatus),
          col: p.col,
          row: p.row
        }))
      )
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [
    drag,
    cell,
    gap,
    columns,
    positions,
    spans,
    tasks,
    onLayoutChange,
    applyDrag,
    clearLongPressTimer
  ])

  /* ---------- 渲染 ---------- */
  const totalRows = useMemo(() => {
    let max = 0
    for (const id of Object.keys(positions)) {
      max = Math.max(max, positions[id].row + (spans[id]?.h ?? 1))
    }
    return Math.max(1, max)
  }, [positions, spans])

  const unit = cell + gap
  const gridHeight = totalRows * unit - gap

  return (
    <div
      ref={gridRef}
      className="tile-grid"
      style={{ height: Math.max(gridHeight, cell) }}
    >
      {/* 拖动时的落点占位框 */}
      {drag?.moved && (
        <div
          className="tile-placeholder"
          style={{
            left: drag.target.col * unit,
            top: drag.target.row * unit,
            width: drag.span.w * cell + (drag.span.w - 1) * gap,
            height: drag.span.h * cell + (drag.span.h - 1) * gap
          }}
        />
      )}

      {tasks.map((task) => {
        const pos = positions[task.id]
        if (!pos) return null
        const span = spans[task.id] ?? { w: 1, h: 1 }
        const isDragging = drag?.taskId === task.id && drag.moved

        // 拖动中的磁贴跟随指针：位置仍按格坐标，靠 transform 补齐差值，避免抖动
        const transform =
          isDragging && drag
            ? `translate(${(drag.target.col - drag.origin.col) * unit}px, ${
                (drag.target.row - drag.origin.row) * unit
              }px) scale(1.06)`
            : undefined

        return (
          <TaskTile
            key={task.id}
            task={task}
            col={pos.col}
            row={pos.row}
            w={span.w}
            h={span.h}
            cell={cell}
            gap={gap}
            dragging={Boolean(isDragging)}
            transform={transform}
            mode={mode}
            selectionMode={selectionMode}
            selected={selectedIds.has(task.id)}
            onDragStart={(e) => handleDragStart(task, e)}
            onActivate={() => {
              // 刚拖完 / 刚长按完的那一下不当作点击
              if (suppressClickRef.current) return
              // 多选模式下点磁贴 = 切换选中；普通模式 = 打开详情
              if (selectionMode) onToggleSelect(task.id)
              else onOpen(task)
            }}
            onToggleSelect={() => onToggleSelect(task.id)}
            onComplete={() => onComplete(task)}
            onDelete={() => onDelete(task)}
            onRestore={() => onRestore(task)}
          />
        )
      })}

      {drag?.moved && (
        <div className="board-drop-hint">
          松开鼠标放置磁贴 · 放到已占用的格子会与之交换位置
        </div>
      )}

      {/*
        §4 边界：已删除分类里长按磁贴 → 二次确认 → 彻底删除。
        确认弹窗放在这里（而不是交给上层）是因为触发它的手势就发生在本组件，
        这样无论外层怎么接线，这个「防误删」都一定生效。
      */}
      <Modal
        open={purgeTarget !== null}
        title="彻底删除任务？"
        subtitle="此操作不可恢复"
        onClose={() => setPurgeTarget(null)}
        width={460}
        footer={
          <>
            <Button variant="subtle" onClick={() => setPurgeTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = purgeTarget
                setPurgeTarget(null)
                if (target) onPurge(target)
              }}
            >
              <Icon.Trash size={14} />
              彻底删除
            </Button>
          </>
        }
      >
        <div className="notice notice-danger">
          <span className="notice-icon">
            <Icon.Warn size={15} />
          </span>
          <span>
            将把「{purgeTarget?.name}」从数据库永久移除（含后台数据），之后无法恢复。
            如果只是想暂时移出列表，请取消后使用选区里的「恢复」。
          </span>
        </div>
      </Modal>
    </div>
  )
}
