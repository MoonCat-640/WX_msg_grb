/**
 * 左侧类别栏
 * ------------------------------------------------------------------
 * 需求原文：
 *   「主界面分为2栏，参考 deepseek 聊天官网的风格，左侧小栏为类别区，
 *     按上面所述显示 4 个类别：进行中、未开始、已完成、已过期。
 *     右侧大栏为具体的任务区」
 *
 * 设计取舍：
 *   - 四个类别是**固定**的，顺序也不变（需求明确列出了这 4 个）
 *   - 每项右侧显示该类别下的任务数；为 0 时数字弱化，避免视觉噪音
 *   - 底部放「联系人选择 / AI Key / 设置 / 日志」等入口——
 *     它们不属于任务分类，但需要随手可达
 */
import type { JSX } from 'react'
import type { TaskStatus } from '@shared/types'
import { Icon, statusIcon } from './icons'

/**
 * 类别的展示顺序与颜色。
 * 顺序即需求里的顺序：「已删除」是更新需求 §4 新增的，排在最后。
 */
export const CATEGORIES: { key: TaskStatus; label: string; color: string }[] = [
  { key: 'ongoing', label: '进行中', color: 'var(--status-ongoing)' },
  { key: 'upcoming', label: '未开始', color: 'var(--status-upcoming)' },
  { key: 'done', label: '已完成', color: 'var(--status-done)' },
  { key: 'expired', label: '已过期', color: 'var(--status-expired)' },
  // 「已删除」用中性灰：它是"回收站"，不该像过期那样抢眼
  { key: 'deleted', label: '已删除', color: 'var(--muted)' }
]

export interface CategorySidebarProps {
  active: TaskStatus
  /** 各类别的任务数 */
  counts: Record<TaskStatus, number>
  onChange: (status: TaskStatus) => void
  onOpenConversations: () => void
  onOpenLlmKeys: () => void
  onOpenSettings: () => void
  onOpenLogs: () => void
  /** 未读/待处理提示（可选）：例如尚未勾选任何会话时给个小红点 */
  pendingHint?: { conversations: boolean; llm: boolean }
}

export function CategorySidebar({
  active,
  counts,
  onChange,
  onOpenConversations,
  onOpenLlmKeys,
  onOpenSettings,
  onOpenLogs,
  pendingHint
}: CategorySidebarProps): JSX.Element {
  return (
    <nav className="sidebar" aria-label="任务类别">
      <div className="sidebar-section">任务分类</div>

      {CATEGORIES.map((cat) => {
        const CatIcon = statusIcon(cat.key)
        const count = counts[cat.key] ?? 0
        return (
          <button
            key={cat.key}
            type="button"
            className={['cat-item', cat.key === active ? 'is-active' : ''].filter(Boolean).join(' ')}
            style={{ ['--cat-color' as string]: cat.color }}
            aria-current={cat.key === active ? 'page' : undefined}
            onClick={() => onChange(cat.key)}
          >
            <span className="cat-icon">
              <CatIcon size={17} />
            </span>
            <span className="grow">{cat.label}</span>
            {count > 0 && <span className="cat-count">{count}</span>}
          </button>
        )
      })}

      <div className="sidebar-spacer" />

      <div className="sidebar-section">数据与设置</div>

      <button type="button" className="side-link" onClick={onOpenConversations}>
        <Icon.Users size={16} />
        <span className="grow">联系人与群聊</span>
        {pendingHint?.conversations && <Dot />}
      </button>

      <button type="button" className="side-link" onClick={onOpenLlmKeys}>
        <Icon.Robot size={16} />
        <span className="grow">AI 平台与 Key</span>
        {pendingHint?.llm && <Dot />}
      </button>

      <button type="button" className="side-link" onClick={onOpenSettings}>
        <Icon.Settings size={16} />
        <span className="grow">设置</span>
      </button>

      <button type="button" className="side-link" onClick={onOpenLogs}>
        <Icon.Log size={16} />
        <span className="grow">运行日志</span>
      </button>
    </nav>
  )
}

/** 待处理小红点 */
function Dot(): JSX.Element {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: 'var(--accent)',
        flex: '0 0 auto'
      }}
    />
  )
}
