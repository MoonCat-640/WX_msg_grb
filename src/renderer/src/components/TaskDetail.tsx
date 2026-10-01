/**
 * 任务详情抽屉（需求「软件功能 第 7 点」）
 * ------------------------------------------------------------------
 * 需求原文：单击磁贴进入任务后，要展示「任务发布的原文」和「材料清单」
 * （共享表格链接、线上问卷、普通表格和文档等）；其中涉及线上链接的，
 * 单击后用「获取该任务的账号」登录后打开。
 *
 * 设计取舍：
 *  1. 磁贴上的「完成 / 删除」要求长按 2.5 秒才生效（防止误触）。
 *     但详情页里这两个操作是用户在明确阅读任务后才点的「明确操作」，
 *     再要求长按会变成纯粹的负担，因此这里改成点击 + 二次确认：
 *     删除用内联确认行（不用 window.confirm，避免阻塞与样式割裂），
 *     完成/重新打开是非破坏性操作，点击即生效。
 *  2. 详情里的时间线需要一个「当前时间」，这里每 30 秒刷新一次，
 *     让进度条位置和剩余时间跟随真实时间前进（注意 cleanup 清定时器）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Task, TaskMaterial, TaskStatus } from '@shared/types'
import {
  endOfUtc8Day,
  formatDateTime,
  humanizeRemaining,
  parseUtc8,
  toDateTimeLocalValue
} from '@shared/time'
import { api, toast, toastError } from '../api'
import type { TaskDetailProps } from './contracts'
import { Button, Drawer, EmptyState, Field, StatusChip } from './primitives'
import { Icon } from './icons'
// 名称缺失时的统一文案（与磁贴同一来源，避免两处说法不一致）
import { nameLabel } from './task-labels'

/* ------------------------------------------------------------------ */
/* 常量与纯函数                                                        */
/* ------------------------------------------------------------------ */

/** 状态中文名（主进程 status.ts 里有同名常量，但那是主进程模块，渲染层不能引用，这里各自维护一份） */
const STATUS_TEXT: Record<TaskStatus, string> = {
  ongoing: '进行中',
  upcoming: '未开始',
  done: '已完成',
  expired: '已过期',
  deleted: '已删除'
}

/** 状态色取自 tokens.css 的语义色，禁止写死色值 */
const STATUS_COLOR: Record<TaskStatus, string> = {
  ongoing: 'var(--status-ongoing)',
  upcoming: 'var(--status-upcoming)',
  done: 'var(--status-done)',
  expired: 'var(--status-expired)',
  // 「已删除」是回收站语义，用中性灰（与左侧类别栏保持一致）
  deleted: 'var(--muted)'
}

type IconCmp = (p: { size?: number }) => JSX.Element

/** 材料类型 → 图标 + 中文标签 */
const MATERIAL_META: Record<TaskMaterial['kind'], { label: string; icon: IconCmp }> = {
  form: { label: '表单 / 共享表格', icon: Icon.Form },
  document: { label: '文档 / 材料', icon: Icon.Doc },
  link: { label: '线上链接', icon: Icon.Link },
  offline: { label: '线下提交', icon: Icon.File },
  unknown: { label: '材料', icon: Icon.File }
}

/**
 * 头像底色：由名字的哈希决定，取一组预置色相。
 * 关键点：必须是「确定性哈希」而不是随机数，否则每次渲染颜色都会跳变。
 * 亮度取 72%，配合 .publisher-avatar 已有的深色文字，保证对比度。
 */
const AVATAR_HUES = [210, 145, 275, 32, 5, 190, 320, 255]
function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `hsl(${AVATAR_HUES[h % AVATAR_HUES.length]} 55% 72%)`
}

/** 截止时间的强调类：已过期用 danger，24 小时内用 warn */
function deadlineClass(endAt: number, now: number): string {
  if (now > endAt) return 'is-overdue'
  if (endAt - now < 24 * 3600 * 1000) return 'is-soon'
  return ''
}

/** 包装一次调用：失败弹提示并返回 false（void 返回值不能用 tryCall 的 null 判定，故单独写一份） */
async function runVoid(fn: () => Promise<unknown>, prefix: string): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (e) {
    toastError(e, prefix)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 子组件：单条材料                                                    */
/* ------------------------------------------------------------------ */

function MaterialRow({
  material,
  accountId,
  accountName
}: {
  material: TaskMaterial
  accountId?: string
  accountName: string | null
}): JSX.Element {
  const meta = MATERIAL_META[material.kind] ?? MATERIAL_META.unknown
  const IconC = meta.icon
  const clickable = Boolean(material.url)

  // 需求：点链接要用「获取该任务的账号」登录后打开，所以把 accountId 透传给主进程
  const handleOpen = (): void => {
    if (!material.url) return
    void api.openExternal(material.url, accountId).catch((e) => toastError(e, '打开链接失败'))
  }

  const body = (
    <>
      <span className="material-icon">
        <IconC size={16} />
      </span>
      <span className="material-body">
        <span className="material-name">
          {material.name || '未命名材料'}
          <span className="td-kind-tag">{meta.label}</span>
          {!material.required && <span className="td-tag-optional">选交</span>}
        </span>
        {material.note && <div className="material-note">{material.note}</div>}
        {material.url && <div className="material-url">{material.url}</div>}
      </span>
      {clickable && (
        <span className="td-material-hint">
          {accountName ? `用「${accountName}」打开` : '新窗口打开'}
        </span>
      )}
    </>
  )

  // 无 url 的条目不可点击（需求：只有线上链接才可点）
  if (!clickable) return <div className="material-item">{body}</div>

  // 用 div + role=button 而不是 <button>：.material-item 内部是块级结构，
  // 且已有样式的 display:flex 是给 div 设计的，这样能直接复用而不必覆盖。
  return (
    <div
      className="material-item is-link"
      role="button"
      tabIndex={0}
      title={`在独立窗口打开：${material.url}`}
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleOpen()
        }
      }}
    >
      {body}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 子组件：起止时间可视化                                              */
/* ------------------------------------------------------------------ */

function TimeRange({ task, now }: { task: Task; now: number }): JSX.Element {
  const { startAt, endAt } = task

  // 两端都没有 → 无法可视化
  if (!startAt && !endAt) {
    return <span className="td-empty-time">未提供时间信息</span>
  }

  // 只有一端 → 画不出「周期进度」，按需求降级为纯文本
  if (!startAt || !endAt) {
    return (
      <span className="td-time-text">
        {startAt ? `开始 ${formatDateTime(startAt)}` : `截止 ${formatDateTime(endAt as number)}`}
        {endAt && (
          <>
            {' · '}
            <span className={`td-deadline ${deadlineClass(endAt, now)}`}>
              {humanizeRemaining(endAt, now)}
            </span>
          </>
        )}
      </span>
    )
  }

  // 两端都有 → 用进度条表示「当前时间在整个任务周期中的位置」
  const span = endAt - startAt
  const ratio = span <= 0 ? 1 : Math.max(0, Math.min(1, (now - startAt) / span))
  return (
    <div className="col gap-xs">
      <div className="timeline">
        <span className="td-timeline-label">{formatDateTime(startAt)}</span>
        <div className="timeline-bar">
          <div
            className="timeline-bar-fill"
            style={{
              left: 0,
              width: `${ratio * 100}%`,
              background: now > endAt ? 'var(--danger)' : 'var(--accent)'
            }}
          />
        </div>
        <span className="td-timeline-label">{formatDateTime(endAt)}</span>
      </div>
      <div>
        <span className={`td-deadline ${deadlineClass(endAt, now)}`}>
          {humanizeRemaining(endAt, now)}
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 编辑态辅助（第二次更新需求 §1b：用户可自由编辑任务）                */
/* ------------------------------------------------------------------ */

/** 详情面板里可编辑的字段（时间用 datetime-local 的字符串形式承载） */
interface TaskDraftFields {
  name: string
  topic: string
  type: string
  /** 多值用「、」分隔的文本（与展示口径一致） */
  organizers: string
  contactPerson: string
  /** `YYYY-MM-DDTHH:mm`（UTC+8 墙钟时间），空串表示"未填写" */
  startAt: string
  endAt: string
}

/** 由任务对象生成编辑草稿 */
function toDraft(task: Task): TaskDraftFields {
  return {
    name: task.name ?? '',
    topic: task.topic ?? '',
    type: task.type ?? '',
    organizers: (task.organizers ?? []).join('、'),
    contactPerson: task.contactPerson ?? '',
    startAt: toDateTimeLocalValue(task.startAt),
    endAt: toDateTimeLocalValue(task.endAt)
  }
}

/** 把「、」/逗号/空白分隔的文本拆成去空数组 */
function splitList(text: string): string[] {
  return text
    .split(/[、,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 草稿 → 提交给 task:update 的 patch。
 * 注意：**不含任何来源字段**（publishers / sourceMessageIds / originalText / llm），
 * 这既满足「AI 抓取的任务不能改来源」，主进程那边还会再拦一道（双保险）。
 */
function draftToPatch(draft: TaskDraftFields): Partial<Task> {
  return {
    name: draft.name.trim(),
    topic: draft.topic.trim(),
    type: draft.type.trim(),
    organizers: splitList(draft.organizers),
    // 清空时置 undefined（而不是空串），与「未明确」的判定口径保持一致
    contactPerson: draft.contactPerson.trim() || undefined,
    startAt: draft.startAt ? parseUtc8(draft.startAt) : undefined,
    endAt: draft.endAt ? parseUtc8(draft.endAt) : undefined
  }
}

/* ------------------------------------------------------------------ */
/* 主组件                                                              */
/* ------------------------------------------------------------------ */

export function TaskDetail({
  open,
  task,
  onClose,
  accounts,
  onChanged
}: TaskDetailProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [busy, setBusy] = useState(false)

  /* ---------------- 编辑态（第二次更新需求 §1b） ----------------
   * 设计取舍：默认仍是「只读展示」，点「编辑」才切换成输入框。
   * 理由：详情面板同时承担「看」的职责，直接铺满输入框会让阅读变累；
   * 编辑态内的改动会**自动保存**（防抖 800ms），满足需求「填写后自动保存」。
   */
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<TaskDraftFields | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  /** AI 生成名称/主题的进行中标志 */
  const [aiBusy, setAiBusy] = useState(false)
  /** 记录最近一次保存完成的时间，用于展示「已保存」提示 */
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // 自动保存的防抖定时器
  const saveTimer = useRef<number | null>(null)

  // 定时刷新「当前时间」，让时间线与剩余时间不因抽屉长时间开着而失真。
  // 关闭抽屉时必须清掉定时器，否则后台会一直空转。
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open])

  // 切换任务或重新打开时，重置本地的临时交互状态
  useEffect(() => {
    setConfirmDelete(false)
    setShowSource(false)
    setBusy(false)
    // 编辑态一并复位：默认只读；草稿跟随被打开的任务
    setEditing(false)
    setDirty(false)
    setSaving(false)
    setSavedAt(null)
    setAiBusy(false)
    setDraft(task ? toDraft(task) : null)
  }, [task?.id, open])

  // 需求：点链接要用「获取该任务的账号」打开 → 取第一个发布人的账号
  const openAccountId = task?.publishers[0]?.accountId
  const openAccountName = useMemo(() => {
    if (!openAccountId) return null
    return accounts.find((a) => a.id === openAccountId)?.displayName ?? null
  }, [accounts, openAccountId])

  /* ---------------- 编辑：修改 / 自动保存 / AI 生成（需求 §1b） ---------------- */

  /** 修改草稿中的某个字段（同时标记为待保存） */
  const updateDraft = useCallback((patch: Partial<TaskDraftFields>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d))
    setDirty(true)
  }, [])

  /** 把当前草稿提交给主进程 */
  const saveDraft = useCallback(async () => {
    if (!task || !draft) return
    setSaving(true)
    try {
      await api.taskUpdate(task.id, draftToPatch(draft))
      setDirty(false)
      setSavedAt(Date.now())
      onChanged()
    } catch (e) {
      toastError(e, '保存任务失败')
    } finally {
      setSaving(false)
    }
  }, [task, draft, onChanged])

  // 自动保存：编辑态下字段改动后防抖 800ms 落库（需求 §1a「填写后自动保存」）
  useEffect(() => {
    if (!editing || !dirty || !task) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void saveDraft()
    }, 800)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [draft, editing, dirty, task, saveDraft])

  /** 进入编辑态 */
  const handleEnterEdit = useCallback(() => {
    if (!task) return
    setDraft(toDraft(task))
    setDirty(false)
    setSavedAt(null)
    setEditing(true)
  }, [task])

  /** 退出编辑态：若还有未保存的改动，先补一次保存 */
  const handleExitEdit = useCallback(async () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    if (dirty) await saveDraft()
    setEditing(false)
  }, [dirty, saveDraft])

  /**
   * 调用 AI 生成名称/主题（需求 §1a：「如果是名称或主题未填写，则调用 AI 生成名称、主题」）。
   * 已有值不覆盖——只补空缺的那一项。
   */
  const handleAiGenerate = useCallback(async () => {
    if (!draft) return
    setAiBusy(true)
    try {
      const r = await api.taskSuggestMeta({
        name: draft.name.trim() || undefined,
        topic: draft.topic.trim() || undefined,
        type: draft.type.trim() || undefined,
        organizers: splitList(draft.organizers),
        contactPerson: draft.contactPerson.trim() || undefined,
        timeText: [draft.startAt, draft.endAt].filter(Boolean).join(' ~ ') || undefined
      })
      if (!r) {
        toast('warn', '未配置可用的 AI 平台或调用失败，请到左侧「AI 平台与 Key」配置后再试')
        return
      }
      setDraft((d) =>
        d ? { ...d, name: d.name.trim() || r.name, topic: d.topic.trim() || r.topic } : d
      )
      setDirty(true)
      toast('ok', 'AI 已生成名称/主题，稍后自动保存')
    } catch (e) {
      toastError(e, 'AI 生成名称/主题失败')
    } finally {
      setAiBusy(false)
    }
  }, [draft])

  const handleSetStatus = async (status: TaskStatus): Promise<void> => {
    if (!task) return
    setBusy(true)
    const ok = await runVoid(() => api.taskSetStatus(task.id, status), '更新任务状态失败')
    setBusy(false)
    if (ok) {
      toast('ok', status === 'done' ? '任务已标记为已完成' : '任务已重新打开')
      onChanged()
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!task) return
    setBusy(true)
    const ok = await runVoid(() => api.taskDelete(task.id), '删除任务失败')
    setBusy(false)
    if (ok) {
      toast('ok', '任务已删除')
      setConfirmDelete(false)
      onChanged()
      onClose()
    }
  }

  const subtitle = task ? (
    <span className="row td-subtitle">
      <span>{task.type || '未分类'}</span>
      <StatusChip color={STATUS_COLOR[task.status]}>{STATUS_TEXT[task.status]}</StatusChip>
      {task.origin === 'manual' && <span className="td-self-tag">手动</span>}
      {typeof task.confidence === 'number' && (
        <span
          className="td-confidence"
          style={task.confidence < 0.6 ? { color: 'var(--warn)' } : undefined}
          title={task.confidence < 0.6 ? '由规则兜底抽取，建议人工核对' : undefined}
        >
          抽取置信度 {Math.round(task.confidence * 100)}%
        </span>
      )}
    </span>
  ) : undefined

  const footer = task ? (
    <div className="row grow td-foot">
      {task.status === 'done' ? (
        <Button variant="subtle" disabled={busy} onClick={() => void handleSetStatus('ongoing')}>
          重新打开
        </Button>
      ) : (
        <Button variant="ok" disabled={busy} onClick={() => void handleSetStatus('done')}>
          标记为已完成
        </Button>
      )}
      <div className="grow" />
      {confirmDelete ? (
        <div className="row td-confirm">
          <span className="text-sm text-secondary">确认删除该任务？</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>
            取消
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => void handleDelete()}
          >
            <Icon.Trash size={13} /> 确认删除
          </Button>
        </div>
      ) : (
        <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
          <Icon.Trash size={14} /> 删除任务
        </Button>
      )}
    </div>
  ) : undefined

  return (
    <Drawer
      open={open}
      width={680}
      title={task ? nameLabel(task) : '任务详情'}
      subtitle={subtitle}
      onClose={onClose}
      footer={footer}
    >
      {!task ? (
        <EmptyState icon={Icon.Grid} title="没有选中的任务" description="请先在任务区单击一个磁贴。" />
      ) : (
        <>
          {/* 1. 基本信息（可编辑：第二次更新需求 §1b） */}
          <section className="detail-section">
            <div className="td-section-head">
              <div className="detail-label">基本信息</div>
              <div className="row gap-xs">
                {editing ? (
                  <>
                    <span className="text-xs text-tertiary">
                      {saving ? '保存中…' : dirty ? '待保存…' : savedAt ? '已自动保存' : '改动自动保存'}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={aiBusy}
                      disabled={aiBusy || saving}
                      onClick={() => void handleAiGenerate()}
                      title="名称/主题留空时，可由 AI 根据已填信息生成"
                    >
                      <Icon.Sparkles size={13} />
                      AI 生成名称/主题
                    </Button>
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={saving}
                      onClick={() => void handleExitEdit()}
                    >
                      完成
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleEnterEdit}
                    title="编辑名称、主题、负责人、接头人与起止时间"
                  >
                    <Icon.Edit size={13} />
                    编辑
                  </Button>
                )}
              </div>
            </div>

            {editing && draft ? (
              <div className="section-card td-edit-form">
                <Field label="名称" hint="留空时磁贴显示「未明确」，可用上方按钮让 AI 生成">
                  <input
                    type="text"
                    value={draft.name}
                    placeholder="例如：2026 年数学建模竞赛报名"
                    onChange={(e) => updateDraft({ name: e.target.value })}
                  />
                </Field>
                <Field label="主题">
                  <input
                    type="text"
                    value={draft.topic}
                    placeholder="一句话说明这个任务要做什么"
                    onChange={(e) => updateDraft({ topic: e.target.value })}
                  />
                </Field>
                <Field label="类型">
                  <input
                    type="text"
                    value={draft.type}
                    placeholder="例如：表单填写 / 材料提交 / 报名"
                    onChange={(e) => updateDraft({ type: e.target.value })}
                  />
                </Field>
                <Field label="负责人 / 组织" hint="多个用「、」分隔">
                  <input
                    type="text"
                    value={draft.organizers}
                    placeholder="例如：教务处、学生会"
                    onChange={(e) => updateDraft({ organizers: e.target.value })}
                  />
                </Field>
                <Field label="接头人">
                  <input
                    type="text"
                    value={draft.contactPerson}
                    placeholder="例如：张老师"
                    onChange={(e) => updateDraft({ contactPerson: e.target.value })}
                  />
                </Field>
                {/* 起止时间：用现代浏览器原生的日期时间选择器（点开就是日历 + 时间） */}
                <div className="td-time-row">
                  <Field label="开始时间">
                    <input
                      type="datetime-local"
                      value={draft.startAt}
                      onChange={(e) => updateDraft({ startAt: e.target.value })}
                    />
                  </Field>
                  <Field label="截止时间">
                    <input
                      type="datetime-local"
                      value={draft.endAt}
                      onChange={(e) => updateDraft({ endAt: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="row gap-xs">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => updateDraft({ endAt: toDateTimeLocalValue(endOfUtc8Day(Date.now())) })}
                  >
                    截止到今天 23:59
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => updateDraft({ startAt: '', endAt: '' })}>
                    清空时间
                  </Button>
                </div>
              </div>
            ) : (
              <div className="section-card">
                <div className="kv">
                  <span className="kv-key">主题</span>
                  <div className="kv-val">{task.topic || '—'}</div>
                </div>
                <div className="kv">
                  <span className="kv-key">类型</span>
                  <div className="kv-val">{task.type || '—'}</div>
                </div>
                <div className="kv">
                  <span className="kv-key">负责人</span>
                  <div className="kv-val">
                    {task.organizers.length > 0 ? task.organizers.join('、') : '—'}
                  </div>
                </div>
                <div className="kv">
                  <span className="kv-key">接头人</span>
                  <div className="kv-val">{task.contactPerson || '—'}</div>
                </div>
                <div className="kv">
                  <span className="kv-key">起止时间</span>
                  <div className="kv-val">
                    <TimeRange task={task} now={now} />
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 2. 材料清单 */}
          <section className="detail-section">
            <div className="detail-label">材料清单</div>
            <div className="notice notice-info td-notice">
              <span className="notice-icon">
                <Icon.Info size={15} />
              </span>
              <span>
                点击带链接的材料会用一个独立的浏览器窗口打开，并复用该任务所属账号的登录状态（不同账号的网页登录态互相隔离）。
              </span>
            </div>
            {task.materials.length === 0 ? (
              <div className="text-tertiary text-sm">未提取到材料信息</div>
            ) : (
              task.materials.map((m, i) => (
                <MaterialRow
                  key={`${m.name}-${i}`}
                  material={m}
                  accountId={openAccountId}
                  accountName={openAccountName}
                />
              ))
            )}
          </section>

          {/* 3. 发布人 */}
          <section className="detail-section">
            <div className="td-section-head">
              <div className="detail-label">发布人</div>
              {task.publishers.length > 1 && (
                <span className="td-count-badge">共 {task.publishers.length} 人发布</span>
              )}
            </div>
            {task.publishers.length === 0 ? (
              <div className="text-tertiary text-sm">未识别到发布人</div>
            ) : (
              <div className="section-card">
                {task.publishers.map((p, i) => (
                  <div
                    className="publisher-item"
                    key={`${p.accountId}:${p.conversationId}:${p.publishedAt}:${i}`}
                  >
                    <span
                      className="publisher-avatar"
                      style={{ background: avatarColor(p.name || '?') }}
                    >
                      {(p.name || '?').slice(0, 1)}
                    </span>
                    <div className="grow col">
                      <div className="td-pub-line">
                        <span className="td-pub-name">{p.name || '未知'}</span>
                        {/* 需求：发布人为「最早发布该任务的用户」，故第一条打标签 */}
                        {i === 0 && <span className="publisher-first">最早发布</span>}
                        {p.isSelf && <span className="td-self-tag">我</span>}
                      </div>
                      <div className="td-pub-sub">
                        {p.conversationName ? `来自「${p.conversationName}」` : '未知群聊'} ·{' '}
                        {formatDateTime(p.publishedAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 4. 任务原文 */}
          <section className="detail-section">
            <div className="detail-label">任务原文</div>
            {task.originalText ? (
              <div className="original-text">{task.originalText}</div>
            ) : (
              <div className="text-tertiary text-sm">未保留原文</div>
            )}
          </section>

          {/* 5. 来源信息（折叠，默认收起） */}
          <section className="detail-section">
            <button
              type="button"
              className="td-collapse-head"
              aria-expanded={showSource}
              onClick={() => setShowSource((v) => !v)}
            >
              <Icon.ChevronDown size={14} className={showSource ? 'td-chevron is-open' : 'td-chevron'} />
              <span className="detail-label td-collapse-label">来源信息</span>
            </button>
            {showSource && (
              <div className="section-card td-source">
                <div className="kv">
                  <span className="kv-key">任务来源</span>
                  <div className="kv-val">
                    {task.origin === 'manual' ? '手动创建' : '从聊天记录自动抽取'}
                    {task.origin !== 'manual' && (
                      <span className="text-xs text-tertiary">（来源信息不可修改）</span>
                    )}
                  </div>
                </div>
                <div className="kv">
                  <span className="kv-key">来源消息</span>
                  <div className="kv-val">{task.sourceMessageIds.length} 条</div>
                </div>
                <div className="kv">
                  <span className="kv-key">抽取模型</span>
                  <div className="kv-val mono text-xs">
                    {task.llm ? `${task.llm.provider} / ${task.llm.model}` : '—'}
                  </div>
                </div>
                <div className="kv">
                  <span className="kv-key">创建时间</span>
                  <div className="kv-val">{formatDateTime(task.createdAt)}</div>
                </div>
                <div className="kv">
                  <span className="kv-key">更新时间</span>
                  <div className="kv-val">{formatDateTime(task.updatedAt)}</div>
                </div>
                <div className="kv">
                  <span className="kv-key">指纹</span>
                  <div className="kv-val mono text-xs td-fingerprint">{task.fingerprint || '—'}</div>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </Drawer>
  )
}
