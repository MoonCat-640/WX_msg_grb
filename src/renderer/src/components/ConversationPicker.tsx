/**
 * 联系人与群聊选择（需求「模块 3：联系人与群聊选择」）
 * ------------------------------------------------------------------
 * 需求原文：登录后自动识别已登录账号，以标签页形式展示每个账号中的
 * 联系人和群聊，支持多选，点击确认后进入下一步。
 *
 * 设计取舍：
 *  1. 勾选只改内存中的 Set，不逐次写库——否则多选上千个会话会产生大量 IPC。
 *     点「确认」时把「由未选变已选」和「由已选变未选」的 id 各汇总成一次
 *     setSelection 调用，一趟提交完。
 *  2. 每个账号的会话列表按需拉取并缓存（首次切到该标签页时拉），
 *     避免每次切标签都重新请求；列表过期时用「刷新列表」按钮强制刷新。
 *  3. 平台名与主题色来自 api.platforms()（真接口），不在界面里写死颜色。
 */
import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Account, Conversation, PlatformDescriptor, PlatformId } from '@shared/types'
import { api, toast, toastError } from '../api'
import type { ConversationPickerProps } from './contracts'
import { Button, EmptyState, Modal, Spinner, Tabs } from './primitives'
import type { TabItem } from './primitives'
import { Icon } from './icons'

/** 平台信息尚未从主进程取回时的兜底显示（不含颜色，颜色用令牌，避免写死色值） */
const PLATFORM_FALLBACK_LABEL: Record<PlatformId, string> = {
  wechat: '微信',
  qq: 'QQ'
  // 更新需求 §1：企业微信已取消接入，故不再有 wecom
}

type KindFilter = 'all' | 'group' | 'contact'

export function ConversationPicker({
  open,
  onClose,
  accounts,
  onConfirmed,
  firstRun
}: ConversationPickerProps): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 每个账号已拉取的会话列表（账号 id → 列表） */
  const [convs, setConvs] = useState<Record<string, Conversation[]>>({})
  /** 目标选中集合（内存态，确认时才落库） */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [platforms, setPlatforms] = useState<PlatformDescriptor[]>([])
  const [keyword, setKeyword] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [busy, setBusy] = useState(false)

  // 打开时重置所有临时状态：重新从服务端的 selected 状态初始化
  useEffect(() => {
    if (!open) return
    setActiveId((prev) =>
      prev && accounts.some((a) => a.id === prev) ? prev : accounts[0]?.id ?? null
    )
    setConvs({})
    setSelected(new Set())
    setKeyword('')
    setKindFilter('all')
    setBusy(false)
    // 说明：只在 open 变化时重置；accounts 在面板打开期间一般不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 平台元信息（标签页的平台名与色点）。取一次即可，取到前用兜底文案。
  useEffect(() => {
    if (!open || platforms.length > 0) return
    let cancelled = false
    api
      .platforms()
      .then((list) => {
        if (!cancelled) setPlatforms(list)
      })
      .catch((e) => {
        if (!cancelled) toastError(e, '读取平台信息失败')
      })
    return () => {
      cancelled = true
    }
  }, [open, platforms.length])

  // 按需拉取当前账号的会话列表；已缓存则跳过
  useEffect(() => {
    if (!open || !activeId) return
    if (convs[activeId]) return
    let cancelled = false
    setLoadingId(activeId)
    api
      .conversations({ accountId: activeId })
      .then((list) => {
        if (cancelled) return
        setConvs((prev) => ({ ...prev, [activeId]: list }))
        // 用服务端已选状态初始化内存选择集合
        setSelected((prev) => {
          const next = new Set(prev)
          for (const c of list) if (c.selected) next.add(c.id)
          return next
        })
      })
      .catch((e) => {
        if (!cancelled) toastError(e, '加载会话列表失败')
      })
      .finally(() => {
        if (!cancelled) setLoadingId((cur) => (cur === activeId ? null : cur))
      })
    return () => {
      cancelled = true
    }
  }, [open, activeId, convs])

  const platformOf = (id: PlatformId): PlatformDescriptor | undefined =>
    platforms.find((p) => p.id === id)

  const activeConvs = activeId ? convs[activeId] ?? [] : []

  // 本地过滤（数据量可能上千，用 useMemo 缓存）
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return activeConvs.filter((c) => {
      if (kindFilter !== 'all' && c.kind !== kindFilter) return false
      if (kw && !c.name.toLowerCase().includes(kw)) return false
      return true
    })
  }, [activeConvs, keyword, kindFilter])

  // 每个账号已选数量（用于标签页角标）
  const selectedCountByAccount = useMemo(() => {
    const map: Record<string, number> = {}
    for (const [accId, list] of Object.entries(convs)) {
      let n = 0
      for (const c of list) if (selected.has(c.id)) n += 1
      map[accId] = n
    }
    return map
  }, [convs, selected])

  const accountTabs: TabItem<string>[] = accounts.map((a: Account) => {
    const meta = platformOf(a.platform)
    return {
      key: a.id,
      label: `${meta?.label ?? PLATFORM_FALLBACK_LABEL[a.platform]} · ${a.displayName}`,
      color: meta?.color,
      badge: selectedCountByAccount[a.id] ?? 0
    }
  })

  const kindTabs: TabItem<KindFilter>[] = [
    { key: 'all', label: '全部' },
    { key: 'group', label: '只看群聊' },
    { key: 'contact', label: '只看联系人' }
  ]

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectAllFiltered = (): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of filtered) next.add(c.id)
      return next
    })

  const clearFiltered = (): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of filtered) next.delete(c.id)
      return next
    })

  // 空账号时强制刷新一次会话列表
  const refreshAccount = async (accountId: string): Promise<void> => {
    setLoadingId(accountId)
    try {
      const list = await api.refreshConversations(accountId)
      setConvs((prev) => ({ ...prev, [accountId]: list }))
      setSelected((prev) => {
        const next = new Set(prev)
        for (const c of list) if (c.selected) next.add(c.id)
        return next
      })
      toast('ok', `已刷新 ${list.length} 个会话`)
    } catch (e) {
      toastError(e, '刷新会话列表失败')
    } finally {
      setLoadingId((cur) => (cur === accountId ? null : cur))
    }
  }

  const handleConfirm = async (): Promise<void> => {
    setBusy(true)
    try {
      const toSelect: string[] = []
      const toDeselect: string[] = []
      for (const list of Object.values(convs)) {
        for (const c of list) {
          const want = selected.has(c.id)
          if (want && !c.selected) toSelect.push(c.id)
          else if (!want && c.selected) toDeselect.push(c.id)
        }
      }
      // 只在确认时统一提交变更，避免勾选过程中高频 IPC
      if (toSelect.length > 0) await api.setSelection(toSelect, true)
      if (toDeselect.length > 0) await api.setSelection(toDeselect, false)

      const chosen: Conversation[] = []
      for (const list of Object.values(convs)) {
        for (const c of list) if (selected.has(c.id)) chosen.push(c)
      }
      onConfirmed(chosen)
      onClose()
    } catch (e) {
      toastError(e, '保存选择失败')
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <div className="row grow">
      <Button variant="ghost" disabled={busy} onClick={onClose}>
        取消
      </Button>
      <div className="grow" />
      <Button
        variant="primary"
        disabled={selected.size === 0 || busy}
        loading={busy}
        onClick={() => void handleConfirm()}
      >
        {firstRun ? '确认并继续' : '确认'}
      </Button>
    </div>
  )

  return (
    <Modal
      open={open}
      width={860}
      closeOnScrim={false}
      title="选择联系人与群聊"
      subtitle="勾选需要读取聊天记录的联系人与群聊；可以按账号切换，逐个选择。"
      onClose={onClose}
      footer={footer}
    >
      {accounts.length === 0 ? (
        <EmptyState
          icon={Icon.Users}
          title="还没有已登录的账号"
          description="请先在右上角的账户里登录至少一个账号，再回来选择联系人与群聊。"
        />
      ) : (
        <>
          <Tabs variant="pill" items={accountTabs} active={activeId ?? ''} onChange={setActiveId} />

          <div className="cp-search">
            <span className="cp-search-icon">
              <Icon.Search size={15} />
            </span>
            <input
              value={keyword}
              placeholder="按名称搜索联系人 / 群聊"
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>

          <div className="cp-toolbar">
            <Button size="sm" variant="ghost" onClick={selectAllFiltered}>
              全选
            </Button>
            <Button size="sm" variant="ghost" onClick={clearFiltered}>
              清空
            </Button>
            <Tabs variant="pill" items={kindTabs} active={kindFilter} onChange={setKindFilter} />
            <span className="cp-toolbar-right">
              已选 <b className="cp-selected-count">{selected.size}</b> 个
            </span>
          </div>

          {loadingId === activeId && activeConvs.length === 0 ? (
            <div className="cp-loading">
              <Spinner size={18} /> 正在加载会话…
            </div>
          ) : activeConvs.length === 0 ? (
            <EmptyState
              icon={Icon.Chat}
              title="该账号还没有可读取的会话"
              description="可能尚未识别到联系人 / 群聊，可以先刷新一次列表。"
              action={
                <Button
                  size="sm"
                  disabled={!activeId || loadingId === activeId}
                  onClick={() => {
                    if (activeId) void refreshAccount(activeId)
                  }}
                >
                  <Icon.Refresh size={14} /> 刷新列表
                </Button>
              }
            />
          ) : (
            <div className="cp-list">
              {filtered.length === 0 ? (
                <div className="cp-none">没有匹配的会话</div>
              ) : (
                filtered.map((c) => {
                  const on = selected.has(c.id)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={['cp-row', on ? 'is-selected' : ''].join(' ')}
                      onClick={() => toggle(c.id)}
                    >
                      <span className={['cp-check', on ? 'is-on' : ''].join(' ')}>
                        {on && <Icon.Check size={12} />}
                      </span>
                      <span className="cp-name ellipsis">{c.name || c.platformConversationId}</span>
                      <span className="cp-meta">
                        {c.kind === 'group' ? (
                          <span className="cp-tag is-group">
                            群聊{c.memberCount ? ` · ${c.memberCount} 人` : ''}
                          </span>
                        ) : (
                          <span className="cp-tag">联系人</span>
                        )}
                        {typeof c.cachedMessageCount === 'number' && c.cachedMessageCount > 0 && (
                          <span className="cp-tag is-cached">已缓存 {c.cachedMessageCount} 条</span>
                        )}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
