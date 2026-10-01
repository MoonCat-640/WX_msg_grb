/**
 * 任务磁贴
 * ------------------------------------------------------------------
 * 需求（软件功能 第 7 点 + README_UPDATE_NEW.md §2.2 / §3 / §4）：
 *   - 类似 Windows10 开始菜单动态磁贴，展示任务缩略信息
 *   - 缩略中展示**接头人 / 负责人 / 起止时间**三行；缺失时用统一文案告知
 *     （§2.2 + 边界补充：未明确 / 未明确 / 未明确起止时间）
 *   - 鼠标移入：略微放大 + 由无明显包边变为白色包边
 *   - 移入时底部显示操作按钮，长按生效
 *   - §3：普通「完成」「删除」的确认时长改为 **1.5 秒**
 *   - §4：`deleted`（已删除）分类里，原「完成 + 删除」区域合并成一个大的
 *     「恢复」按钮，**无需确认，点击即生效**
 *   - §3：多选模式下磁贴**左上角**出现复选框，选中时显示对勾
 *
 * 视觉设计取舍：
 *   - 左侧有一条状态色竖条，一眼扫出任务状态
 *   - 三种尺寸：1×1 / 2×1 / 2×2，由内容量决定（稳定的函数，不会抖动）
 *   - 1×1 空间放不下三行元信息时改用**紧凑排版**（小字号 + 单行省略），
 *     但**不隐藏任何一行**——需求明确要求「不要把信息截掉不显示」
 */
import type { JSX } from 'react'
import type { Task } from '@shared/types'
import { Icon, statusIcon } from './icons'
import { LongPressButton } from './LongPressButton'
import {
  contactLabel,
  isContactUnknown,
  isNameUnknown,
  isOrganizerUnknown,
  isTimeUnknown,
  nameLabel,
  organizerLabel,
  timeLabel
} from './task-labels'
// 本模块新增的样式集中放在 views-tiles.css。
// 直接从组件里 import 而不改 main.tsx（main.tsx 由他人维护），
// 规则里用足够的选择器权重保证不被 layout.css 覆盖。
import '../styles/views-tiles.css'

/**
 * 普通操作（完成 / 删除）的确认时长。
 * README_UPDATE_NEW.md §3：由 2.5 秒改为 **1.5 秒**。
 */
export const CONFIRM_MS = 1500

/** 状态 → 颜色（与 tokens.css 的 --status-* 一一对应） */
export const STATUS_COLOR: Record<Task['status'], string> = {
  ongoing: 'var(--status-ongoing)',
  upcoming: 'var(--status-upcoming)',
  done: 'var(--status-done)',
  expired: 'var(--status-expired)',
  // 「已删除」是分类而非物理删除（§4）。tokens.css 里没有专门的 --status-deleted，
  // 用中性灰表达「已归档、不再是活跃任务」；不新增变量以免与令牌表冲突。
  deleted: 'var(--muted)'
}

export const STATUS_TEXT: Record<Task['status'], string> = {
  ongoing: '进行中',
  upcoming: '未开始',
  done: '已完成',
  expired: '已过期',
  deleted: '已删除'
}

/**
 * 决定磁贴占几个格子。
 * 必须是**任务的纯函数**（只依据内容），否则每次渲染尺寸都可能变，磁贴会跳。
 */
export function tileSpan(task: Task): { w: number; h: number } {
  const materialCount = task.materials?.length ?? 0
  const topicLen = (task.topic ?? '').length
  const nameLen = (task.name ?? '').length

  // 内容丰富的任务给 2×2，像 Win10 的"大磁贴"
  if (materialCount >= 3 && (topicLen > 18 || nameLen > 16)) return { w: 2, h: 2 }
  // 一般有材料或主题较长 → 宽磁贴
  if (materialCount >= 2 || topicLen > 22 || nameLen > 18) return { w: 2, h: 1 }
  return { w: 1, h: 1 }
}

/** 当前分类：normal = 正常分类（含进行中/未开始/已完成/已过期）；deleted = 已删除分类 */
export type TileMode = 'normal' | 'deleted'

export interface TaskTileProps {
  task: Task
  /** 网格坐标（列、行） */
  col: number
  row: number
  /** 占用格数 */
  w: number
  h: number
  /** 单元格边长与间距（从 CSS 变量读出来后传进来，便于统一计算） */
  cell: number
  gap: number
  /** 是否正在被拖动（拖动时由网格设置，磁贴只负责视觉） */
  dragging: boolean
  /** 拖动中的位移（由网格计算，形如 translate(...) scale(...)）；非拖动状态为 undefined */
  transform?: string
  /** 当前分类。deleted 时操作区合并成一个大「恢复」按钮（§4） */
  mode: TileMode
  /** 是否处于多选模式：显示左上角复选框、隐藏底部操作按钮 */
  selectionMode: boolean
  /** 是否被选中（仅多选模式有意义） */
  selected: boolean
  /** 拖动过程中按下（由磁贴上报给网格，网格负责后续计算；多选模式下由网格忽略） */
  onDragStart: (e: React.PointerEvent<HTMLDivElement>) => void
  /**
   * 激活磁贴。普通模式 = 打开详情；多选模式 = 由网格转成「切换选中」。
   * 这样磁贴本身不必知道多选语义，点击行为统一由网格决定。
   */
  onActivate: () => void
  /** 点击左上角复选框（仅多选模式渲染） */
  onToggleSelect: () => void
  onComplete: () => void
  onDelete: () => void
  /** 从「已删除」恢复（点击即生效，无长按、无确认） */
  onRestore: () => void
}

export function TaskTile({
  task,
  col,
  row,
  w,
  h,
  cell,
  gap,
  dragging,
  transform,
  mode,
  selectionMode,
  selected,
  onDragStart,
  onActivate,
  onToggleSelect,
  onComplete,
  onDelete,
  onRestore
}: TaskTileProps): JSX.Element {
  const color = STATUS_COLOR[task.status]
  // 「已删除」用垃圾桶图标更直观；statusIcon 里没有这个分类，兜底是网格图标
  const StatusIcon = task.status === 'deleted' ? Icon.Trash : statusIcon(task.status)

  const width = w * cell + (w - 1) * gap
  const height = h * cell + (h - 1) * gap
  const left = col * (cell + gap)
  const top = row * (cell + gap)

  // 1×1 空间最紧张：改用紧凑排版（小字号、单行省略），但三行信息一个都不少
  const compact = w === 1 && h === 1

  // 截止时间的紧迫度：用于变色提醒
  const now = Date.now()
  const deadlineClass =
    task.endAt === undefined
      ? ''
      : task.endAt < now
        ? 'is-overdue'
        : task.endAt - now < 24 * 3600 * 1000
          ? 'is-soon'
          : ''

  // 已完成/已过期的任务用降饱和处理，视觉上"退到后面"。
  // 「已删除」不降饱和——它仍是可操作的（恢复），压暗会让人以为不可点。
  const dimmed = task.status === 'done' || task.status === 'expired'

  // 三个字段的展示文案统一从 task-labels.ts 取（与详情页同一套说法）
  const contact = contactLabel(task)
  const organizer = organizerLabel(task)
  const time = timeLabel(task)

  return (
    <div
      className={[
        'tile',
        compact ? 'tile-compact' : '',
        selectionMode ? 'is-selecting' : '',
        selected ? 'is-selected' : '',
        dragging ? 'is-dragging' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left,
        top,
        width,
        height,
        ['--tile-color' as string]: color,
        opacity: dimmed && !dragging ? 0.82 : undefined,
        // 拖动中由网格给出位移；非拖动时为 undefined，交还给 CSS hover 的缩放
        transform
      }}
      // 点击 / 键盘激活统一交给网格：普通模式打开详情，多选模式切换选中
      onClick={onActivate}
      onPointerDown={onDragStart}
      role="button"
      tabIndex={0}
      aria-pressed={selectionMode ? selected : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate()
        }
      }}
      title={`${task.name}\n${task.topic || ''}`}
    >
      {/* 多选复选框：左上角，自绘（§3：选中的任务在复选框中有对勾提示已选中） */}
      {selectionMode && (
        <span
          className={['sel-check', selected ? 'is-on' : ''].filter(Boolean).join(' ')}
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? '取消选中' : '选中该任务'}
          // 阻止冒泡：否则会二次触发磁贴的 onClick（点击 = 切换选中）而互相抵消
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect()
          }}
        >
          {selected && <Icon.Check size={13} />}
        </span>
      )}

      {/* 类型 + 状态 */}
      <div className="tile-type">
        <StatusIcon size={12} />
        <span>{task.type || '任务'}</span>
        {task.llm === undefined && task.origin !== 'manual' && (
          // 规则兜底抽取的任务明确标出来，提示用户核对
          <span
            className="chip chip-sm"
            style={{ color: 'var(--warn)' }}
            title="由规则兜底抽取，未使用大模型，建议人工核对"
          >
            规则
          </span>
        )}
        {task.origin === 'manual' && (
          // 手动创建的任务（第二次更新需求 §1a）单独标一下，和自动抽取区分开
          <span className="chip chip-sm" title="由你手动创建的任务">
            手动
          </span>
        )}
        {(task.publishers?.length ?? 0) > 1 && (
          // 需求：缩略图不展示多发布人，只用一个极小的角标提示"还有别的群也发了"
          <span
            className="tile-multi"
            title={`共 ${task.publishers.length} 人/群发布，详情里查看`}
            style={{ marginLeft: 'auto' }}
          >
            <Icon.Users size={11} />
            {task.publishers.length}
          </span>
        )}
      </div>

      <div className={['tile-name', isNameUnknown(task) ? 'is-unknown' : ''].filter(Boolean).join(' ')}>
        {nameLabel(task)}
      </div>

      {!compact && (
        <div className="tile-topic">
          {task.topic || task.originalText?.slice(0, 60) || '（无主题）'}
        </div>
      )}

      <div className="tile-spacer" />

      {/*
        底部元信息（§2.2）：接头人 / 负责人 / 起止时间，分开成行。
        缺失的字段不隐藏，而是显示统一文案并做弱化处理，让用户一眼知道"这里是空的"。
      */}
      <div className="tile-meta">
        <div
          className={['tile-meta-row', isContactUnknown(task) ? 'is-unknown' : ''].filter(Boolean).join(' ')}
          title={`接头人：${contact}`}
        >
          <Icon.User size={11} />
          <span className="ellipsis">{contact}</span>
        </div>
        <div
          className={['tile-meta-row', isOrganizerUnknown(task) ? 'is-unknown' : ''].filter(Boolean).join(' ')}
          title={`负责人：${organizer}`}
        >
          <Icon.Users size={11} />
          <span className="ellipsis">{organizer}</span>
        </div>
        <div
          className={['tile-meta-row', 'tile-deadline', deadlineClass, isTimeUnknown(task) ? 'is-unknown' : '']
            .filter(Boolean)
            .join(' ')}
          title={`起止时间：${time}`}
        >
          <Icon.Clock size={11} />
          <span className="ellipsis">{time}</span>
        </div>
      </div>

      {/*
        底部操作（悬停时出现）。多选模式下整块操作区隐藏：
        批量操作统一由顶部工具栏负责，避免"点磁贴选中"与"点按钮执行"两套手势打架。
      */}
      {!selectionMode && (
        // 阻止冒泡：点操作按钮不应该顺带把详情抽屉也打开
        <div
          className={['tile-actions', mode === 'deleted' ? 'is-single' : ''].filter(Boolean).join(' ')}
          onClick={(e) => e.stopPropagation()}
        >
          {mode === 'deleted' ? (
            // §4：已删除分类里，「完成 + 删除」两个按钮的区域合并成一个大的「恢复」按钮，
            // 无需确认、点击即生效（所以是普通 button，不是 LongPressButton）
            <button
              type="button"
              className="tile-action tile-action-restore"
              title="恢复该任务（点击立即生效）"
              onClick={onRestore}
            >
              <Icon.Refresh size={14} />
              <span>恢复</span>
            </button>
          ) : (
            <>
              {task.status === 'done' ? (
                // 已完成的任务不再提供"完成"，改为提示，避免误操作
                <div className="tile-action tile-action-done" style={{ color: 'var(--ok)' }}>
                  <Icon.Check size={14} />
                  <span>已完成</span>
                </div>
              ) : (
                <LongPressButton
                  className="tile-action tile-action-ok"
                  durationMs={CONFIRM_MS}
                  onComplete={onComplete}
                >
                  <Icon.Check size={14} />
                  <span>完成</span>
                </LongPressButton>
              )}
              <LongPressButton
                className="tile-action tile-action-del"
                // §4 边界：删除 = 移入「已删除」分类，而非彻底删除
                title={`长按 ${CONFIRM_MS / 1000} 秒移入「已删除」分类`}
                durationMs={CONFIRM_MS}
                onComplete={onDelete}
              >
                <Icon.Trash size={14} />
                <span>删除</span>
              </LongPressButton>
            </>
          )}
        </div>
      )}
    </div>
  )
}
