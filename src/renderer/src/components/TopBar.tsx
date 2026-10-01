/**
 * 顶栏
 * ------------------------------------------------------------------
 * 组成（从左到右）：
 *   品牌标识 · 搜索框 · 同步状态胶囊 · 立即同步 / 抽取任务 · 账户按钮（右上角）
 *
 * 需求相关：
 *   - 「右上角为账户，平时为显示 "My Account" 字样的按钮」→ 由 AccountButton 实现
 *   - 「实时更新」→ 同步状态胶囊要能一眼看出「正在读 / 上次读完是什么时候」
 */
import { useState, type JSX } from 'react'
import type { Account, PlatformDescriptor, SyncProgress } from '@shared/types'
import { Icon } from './icons'
import { Button, IconButton } from './primitives'
import { AccountButton } from './AccountButton'

export interface TopBarProps {
  keyword: string
  onKeywordChange: (v: string) => void
  syncProgress: SyncProgress
  /** 是否正在同步（用于按钮文案与禁用） */
  syncing: boolean
  onStartSync: () => void
  onStopSync: () => void
  /** 手动触发一次任务抽取 */
  onExtract: () => void
  extracting: boolean
  /**
   * 手动新增任务（第二次更新需求 §1a）。
   * 需求：在「抽取任务」按钮旁放一个样式相同的「新增任务」按钮。
   */
  onNewTask: () => void
  newTaskBusy?: boolean
  accounts: Account[]
  platforms: PlatformDescriptor[]
  onOpenAccountManager: () => void
}

/** 同步状态 → 中文文案与样式类 */
function describeSync(p: SyncProgress): { cls: string; text: string } {
  const cls =
    p.state === 'error'
      ? 'is-error'
      : p.state === 'idle'
        ? 'is-idle'
        : p.state === 'stopped'
          ? 'is-idle'
          : 'is-active'
  const text = p.message || '空闲'
  return { cls, text }
}

export function TopBar({
  keyword,
  onKeywordChange,
  syncProgress,
  syncing,
  onStartSync,
  onStopSync,
  onExtract,
  extracting,
  onNewTask,
  newTaskBusy,
  accounts,
  platforms,
  onOpenAccountManager
}: TopBarProps): JSX.Element {
  // 搜索框里有没有内容：
  // 用受控输入 + 本地上一个值比较会绕，这里用小 state 就够了
  const [showClear, setShowClear] = useState(false)
  const sync = describeSync(syncProgress)

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon.Chat size={13} strokeWidth={2.2} />
        </span>
        <span className="brand-text">任务汇总台</span>
      </div>

      <div className="topbar-search">
        <span className="search-icon">
          <Icon.Search size={14} />
        </span>
        <input
          type="text"
          placeholder="搜索任务名称 / 主题 / 原文…"
          value={keyword}
          onChange={(e) => {
            onKeywordChange(e.target.value)
            setShowClear(e.target.value.length > 0)
          }}
        />
        {showClear && (
          <span className="search-clear">
            <IconButton
              icon={Icon.Close}
              size={13}
              title="清除搜索"
              onClick={() => {
                onKeywordChange('')
                setShowClear(false)
              }}
            />
          </span>
        )}
      </div>

      {/* 同步状态：需求要求「实时更新」，这里让用户随时知道后台在做什么 */}
      <div
        className={['sync-pill', sync.cls].join(' ')}
        title={syncProgress.currentConversation ? `正在处理：${syncProgress.currentConversation}` : sync.text}
      >
        <span className="sync-dot" />
        <span className="ellipsis" style={{ maxWidth: 240 }}>
          {sync.text}
        </span>
        {syncProgress.progress !== undefined && sync.cls === 'is-active' && (
          <span className="text-xs text-tertiary">{Math.round(syncProgress.progress * 100)}%</span>
        )}
      </div>

      {syncing ? (
        <Button size="sm" variant="ghost" onClick={onStopSync} title="停止实时同步">
          <Icon.Stop size={14} />
          停止同步
        </Button>
      ) : (
        <Button size="sm" variant="subtle" onClick={onStartSync} title="开始实时同步（定时轮询读取聊天记录）">
          <Icon.Sync size={14} />
          开始同步
        </Button>
      )}

      <Button
        size="sm"
        variant="subtle"
        loading={extracting}
        onClick={onExtract}
        title="重新扫描每个会话最近的一批聊天记录并抽取任务；已存在的任务会自动合并，不会重复"
      >
        <Icon.Sparkles size={14} />
        抽取任务
      </Button>

      {/* 手动新增任务（第二次更新需求 §1a）：样式与「抽取任务」完全一致 */}
      <Button
        size="sm"
        variant="subtle"
        loading={newTaskBusy}
        onClick={onNewTask}
        title="手动新建一个任务（不依赖聊天记录），可自行填写名称、时间、负责人等"
      >
        <Icon.Plus size={14} />
        新增任务
      </Button>

      <div className="account-wrap">
        <AccountButton
          accounts={accounts}
          platforms={platforms}
          onClick={onOpenAccountManager}
        />
      </div>
    </header>
  )
}
