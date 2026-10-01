/**
 * 账户管理（需求 UI 设计 第 4 点：「单击按钮后进入账户管理界面，
 * 可以选择退出某账号或添加登录账号」）
 * ------------------------------------------------------------------
 * 设计取舍：
 *   - 「移除」是破坏性操作，必须二次确认。这里用内联确认行而不是 window.confirm：
 *     Electron 里原生 confirm 会阻塞渲染进程、样式也和暗色主题割裂。
 *   - 重命名就地编辑 displayName 与 note（备注），保存时走 account:update。
 *   - 每个平台分组都显示「已登录 N/2」，达到上限后禁用添加按钮并给出原因，
 *     让用户明白为什么点不动，而不是一个沉默的灰按钮。
 */
import { useState, type JSX } from 'react'
import type { Account, AccountState, PlatformDescriptor } from '@shared/types'
import { api, toast, tryCall } from '../api'
import { Button, EmptyState, IconButton, Modal, StatusChip } from './primitives'
import { Icon } from './icons'
import type { AccountManagerProps } from './contracts'

/** 账号状态 → 徽章文案与颜色（颜色一律取 tokens.css 的语义色变量） */
const STATE_META: Record<AccountState, { label: string; color: string }> = {
  online: { label: '在线', color: 'var(--ok)' },
  offline: { label: '离线', color: 'var(--muted)' },
  expired: { label: '已失效', color: 'var(--danger)' }
}

export function AccountManager({
  open,
  onClose,
  accounts,
  platforms,
  onChanged,
  onAddAccount
}: AccountManagerProps): JSX.Element {
  /** 正在就地编辑的账号 id */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editNote, setEditNote] = useState('')
  /** 等待二次确认移除的账号 id */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const beginEdit = (a: Account): void => {
    setConfirmId(null)
    setEditingId(a.id)
    setEditName(a.displayName)
    setEditNote(a.note ?? '')
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setEditName('')
    setEditNote('')
  }

  const saveEdit = async (a: Account): Promise<void> => {
    setBusy(true)
    const res = await tryCall(
      () =>
        api.accountUpdate(a.id, {
          // 显示名不允许被清空，空则保留原名
          displayName: editName.trim() || a.displayName,
          note: editNote.trim() || undefined
        }),
      '保存账号信息'
    )
    setBusy(false)
    if (!res) return
    cancelEdit()
    toast('ok', '已保存')
    onChanged()
  }

  const removeAccount = async (a: Account): Promise<void> => {
    setBusy(true)
    const res = await tryCall(() => api.accountRemove(a.id), '移除账号')
    setBusy(false)
    if (!res) return
    setConfirmId(null)
    if (editingId === a.id) cancelEdit()
    toast('ok', `已移除「${a.displayName}」`)
    onChanged()
  }

  const renderAccount = (a: Account, p: PlatformDescriptor): JSX.Element => {
    const meta = STATE_META[a.state] ?? STATE_META.offline

    // 1) 就地编辑：显示名 + 备注两个输入框
    if (editingId === a.id) {
      return (
        <div className="acct-row acct-row-edit" key={a.id}>
          <span className="account-popover-dot" style={{ background: p.color }} />
          <div className="acct-edit grow">
            <input
              className="acct-input"
              value={editName}
              placeholder="显示名"
              onChange={(e) => setEditName(e.target.value)}
            />
            <input
              className="acct-input"
              value={editNote}
              placeholder="备注（可选）"
              onChange={(e) => setEditNote(e.target.value)}
            />
            <div className="acct-edit-foot">
              <Button size="sm" variant="ghost" onClick={cancelEdit}>
                取消
              </Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void saveEdit(a)}>
                保存
              </Button>
            </div>
          </div>
        </div>
      )
    }

    // 2) 二次确认移除：内联确认行，避免 window.confirm 阻塞与主题割裂
    if (confirmId === a.id) {
      return (
        <div className="acct-row acct-confirm" key={a.id}>
          <Icon.Warn size={14} className="acct-confirm-icon" />
          <span className="grow">
            确定移除账号「{a.displayName}」？该账号的聊天记录读取将一并停止。
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
            取消
          </Button>
          <Button size="sm" variant="danger" loading={busy} onClick={() => void removeAccount(a)}>
            移除
          </Button>
        </div>
      )
    }

    // 3) 普通展示行
    return (
      <div className="acct-row" key={a.id}>
        <span className="account-popover-dot" style={{ background: p.color }} />
        <div className="acct-main grow">
          <div className="acct-name-row">
            <span className="acct-name">{a.displayName}</span>
            <span className="acct-uid mono">{a.platformAccountId}</span>
            <StatusChip color={meta.color}>{meta.label}</StatusChip>
            {a.detectedLocally && (
              <span className="acct-tag" title="由本机数据目录扫描得到，非扫码登录">
                本机识别
              </span>
            )}
          </div>
          {a.note && <div className="acct-note">{a.note}</div>}
          {a.detectedLocally && a.dbStorageDir && (
            // 目录很长，CSS 截断 + title 悬浮查看完整路径
            <div className="acct-db mono" title={a.dbStorageDir}>
              {a.dbStorageDir}
            </div>
          )}
        </div>
        <div className="acct-actions">
          <IconButton icon={Icon.Edit} title="重命名 / 编辑备注" onClick={() => beginEdit(a)} />
          <IconButton icon={Icon.Trash} title="移除账号" onClick={() => setConfirmId(a.id)} />
        </div>
      </div>
    )
  }

  const body =
    accounts.length === 0 ? (
      <EmptyState
        icon={Icon.User}
        title="尚未添加任何账号"
        description={
          <>
            添加微信或 QQ 账号后，才能读取聊天记录并提取其中的任务。
            <br />
            微信可直接扫描本机已登录的账号；QQ 需要填写数据库密钥（可复用 QQFlow 已提取的）。
          </>
        }
        action={
          <Button variant="primary" onClick={onAddAccount}>
            <Icon.Plus size={14} /> 添加账号
          </Button>
        }
      />
    ) : (
      <div className="acct-body">
        {platforms.map((p) => {
          const list = accounts.filter((a) => a.platform === p.id)
          const full = list.length >= p.maxAccounts
          return (
            <section className="acct-group" key={p.id}>
              <header className="acct-group-head">
                <span className="account-popover-dot" style={{ background: p.color }} />
                <span className="acct-group-title">{p.label}</span>
                <span className="acct-group-count">
                  已登录 {list.length}/{p.maxAccounts}
                </span>
                <div className="grow" />
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={full}
                  title={
                    full
                      ? `${p.label} 每个平台最多 ${p.maxAccounts} 个账号，请先移除一个再添加`
                      : `添加${p.label}账号`
                  }
                  onClick={onAddAccount}
                >
                  <Icon.Plus size={13} /> 添加
                </Button>
              </header>

              {!p.dataSourceReady && (
                <div className="notice notice-warn acct-notice">
                  <span className="notice-icon">
                    <Icon.Warn size={14} />
                  </span>
                  <span>该平台暂未接入聊天记录读取，仅支持账号登记。</span>
                </div>
              )}

              <div className="acct-list">
                {list.length === 0 ? (
                  <div className="acct-empty-line">该平台还没有登录账号</div>
                ) : (
                  list.map((a) => renderAccount(a, p))
                )}
              </div>
            </section>
          )
        })}
      </div>
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="账户管理"
      subtitle="查看、重命名、移除已登录的平台账号"
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" onClick={onAddAccount}>
            <Icon.Plus size={14} /> 添加账号
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  )
}
