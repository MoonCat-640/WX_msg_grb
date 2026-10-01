/**
 * 多选工具栏
 * ------------------------------------------------------------------
 * 需求（README_UPDATE_NEW.md §3 + 边界补充）：
 *   「多选模式下，顶部工具栏显示"已选中 X 项"及操作按钮（全选/反选/清除），
 *     底部显示"取消多选"按钮。」
 *   「一键清除使用与任务中"删除"相同的红色，确认持续时间为 2.5 秒。」
 *   「'已删除'标签页的一键清除：确认时间延长到 3 秒，并在清除前弹窗二次确认。」
 *
 * 视觉参照：主流手机系统相册的批量选择（顶部计数 + 批量动作，底部退出）。
 *
 * 时长来源（都在 README_UPDATE_NEW.md §3 / 边界补充里写死了，不要随手改）：
 *   - 一键清除（普通分类）     2500ms
 *   - 一键清除（已删除分类）   3000ms + 弹窗二次确认
 *   - 批量彻底删除            1500ms（需求未单列；它同样不可恢复，
 *                             故沿用普通「删除」的 1.5 秒确认，且用红色）
 */
import { useState, type JSX } from 'react'
import type { TaskStatus } from '@shared/types'
import { Button, Modal } from './primitives'
import { Icon } from './icons'
import { LongPressButton } from './LongPressButton'

/** 一键清除（普通分类）的确认时长：§3 原文 2.5 秒 */
const CLEAR_MS = 2500
/** 一键清除（已删除分类）的确认时长：§3 边界补充 3 秒 */
const CLEAR_DELETED_MS = 3000
/** 批量彻底删除的确认时长：沿用普通「删除」的 1.5 秒（§3） */
const BATCH_PURGE_MS = 1500

export interface SelectionToolbarProps {
  /** 当前分类 */
  status: TaskStatus
  selectedCount: number
  totalCount: number
  /** 全选 */
  onSelectAll: () => void
  /** 全不选 */
  onSelectNone: () => void
  /** 反选 */
  onInvert: () => void
  /** 批量移入已删除 */
  onBatchDelete: () => void
  /** 批量恢复 */
  onBatchRestore: () => void
  /** 批量彻底删除（仅已删除分类） */
  onBatchPurge: () => void
  /** 一键清除当前分类（长按 2.5s / 已删除分类 3s + 弹窗二次确认） */
  onClearCategory: () => void
  /** 退出多选模式 */
  onExitSelection: () => void
  busy?: boolean
}

export function SelectionToolbar({
  status,
  selectedCount,
  totalCount,
  onSelectAll,
  onSelectNone,
  onInvert,
  onBatchDelete,
  onBatchRestore,
  onBatchPurge,
  onClearCategory,
  onExitSelection,
  busy = false
}: SelectionToolbarProps): JSX.Element {
  const isDeleted = status === 'deleted'
  const noneSelected = selectedCount === 0
  const allSelected = totalCount > 0 && selectedCount === totalCount

  /** 已删除分类的一键清除需要二次确认，先记下用户已触发，再弹窗 */
  const [confirmingClear, setConfirmingClear] = useState(false)

  return (
    <>
      {/* ---------------- 顶部工具栏 ---------------- */}
      <div className="sel-toolbar" role="toolbar" aria-label="多选操作">
        <div className="sel-count">
          已选中 <strong>{selectedCount}</strong> 项
          <span className="sel-count-total"> / 共 {totalCount} 项</span>
        </div>

        <div className="sel-actions">
          {/* 选择辅助：全选 / 全不选 / 反选 */}
          <Button size="sm" variant="ghost" disabled={busy || allSelected} onClick={onSelectAll}>
            <Icon.Check size={14} />
            全选
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || noneSelected} onClick={onSelectNone}>
            <Icon.Minus size={14} />
            全不选
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || totalCount === 0} onClick={onInvert}>
            <Icon.Refresh size={14} />
            反选
          </Button>

          <span className="sel-divider" aria-hidden="true" />

          {/* 批量动作：随分类变化 */}
          {isDeleted ? (
            <>
              <Button
                size="sm"
                variant="ok"
                disabled={busy || noneSelected}
                title="把选中的任务恢复回原分类（根据起止时间自动归入未开始/进行中/已过期）"
                onClick={onBatchRestore}
              >
                <Icon.Refresh size={14} />
                恢复所选 ({selectedCount})
              </Button>
              <LongPressButton
                className="sel-danger-btn"
                durationMs={BATCH_PURGE_MS}
                disabled={busy || noneSelected}
                title={`长按 ${BATCH_PURGE_MS / 1000} 秒彻底删除选中的 ${selectedCount} 个任务（不可恢复）`}
                onComplete={onBatchPurge}
              >
                <Icon.Trash size={14} />
                <span>彻底删除所选 ({selectedCount})</span>
              </LongPressButton>
            </>
          ) : (
            <Button
              size="sm"
              variant="danger"
              disabled={busy || noneSelected}
              title={`把选中的 ${selectedCount} 个任务移入「已删除」分类（之后可恢复）`}
              onClick={onBatchDelete}
            >
              <Icon.Trash size={14} />
              移入已删除 ({selectedCount})
            </Button>
          )}

          {/* 一键清除：清除当前分类的全部任务（红色，与「删除」同色） */}
          <LongPressButton
            className="sel-danger-btn"
            durationMs={isDeleted ? CLEAR_DELETED_MS : CLEAR_MS}
            disabled={busy || totalCount === 0}
            title={
              isDeleted
                ? `长按 ${CLEAR_DELETED_MS / 1000} 秒清空「已删除」分类（需再次确认）`
                : `长按 ${CLEAR_MS / 1000} 秒清空当前分类的全部任务（不影响账号与 API Key）`
            }
            onComplete={() => {
              // §3 边界补充：已删除分类的清除必须先弹窗二次确认，防止永久丢失
              if (isDeleted) setConfirmingClear(true)
              else onClearCategory()
            }}
          >
            <Icon.Warn size={14} />
            <span>清除本分类</span>
          </LongPressButton>
        </div>
      </div>

      {/* ---------------- 底部：退出多选 ---------------- */}
      <div className="sel-bottom">
        <Button size="sm" variant="subtle" onClick={onExitSelection}>
          <Icon.Close size={14} />
          取消多选
        </Button>
        <span className="sel-hint">长按磁贴可再次进入多选 · 多选模式下拖拽已停用</span>
      </div>

      {/* 已删除分类「一键清除」的二次确认 */}
      <Modal
        open={confirmingClear}
        title="彻底清空「已删除」分类？"
        subtitle="此操作不可恢复"
        onClose={() => setConfirmingClear(false)}
        width={460}
        footer={
          <>
            <Button variant="subtle" onClick={() => setConfirmingClear(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmingClear(false)
                onClearCategory()
              }}
            >
              <Icon.Trash size={14} />
              彻底清空（{totalCount} 项）
            </Button>
          </>
        }
      >
        <div className="notice notice-danger">
          <span className="notice-icon">
            <Icon.Warn size={15} />
          </span>
          <span>
            将永久删除「已删除」分类中的全部 {totalCount} 个任务（含后台数据），之后无法恢复。
            已登录的账号与 API Key 不受影响。
          </span>
        </div>
      </Modal>
    </>
  )
}
