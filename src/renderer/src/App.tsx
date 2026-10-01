/**
 * 应用主壳
 * ------------------------------------------------------------------
 * 职责：
 *   ① 启动时加载全局状态（保险库 / 设置 / 平台 / 账号）
 *   ② 编排「首次配置」流程：登录账号 → 选择联系人与群聊 → 配置 AI Key → 进入主界面
 *   ③ 订阅主进程推送，保持任务列表与同步状态实时更新
 *   ④ 渲染主界面（左类别栏 + 右磁贴区）与各种浮层
 *
 * 状态管理取舍：没有引入 Redux/Zustand 之类的状态库。
 *   本应用的状态都是「一份数据 + 少量 UI 开关」，用 useState + 一个 reload 函数
 *   已经足够清晰，少一个依赖就少一处出问题的可能。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  Account,
  AppInfo,
  AppSettings,
  PlatformDescriptor,
  Task,
  TaskStatus,
  TileLayout,
  VaultStatus
} from '@shared/types'
import type { SyncProbeResult } from '@shared/ipc'
import { api, on, toast, toastError } from './api'
import { CategorySidebar } from './components/CategorySidebar'
import { TopBar } from './components/TopBar'
import { TileGrid } from './components/TileGrid'
import { SelectionToolbar } from './components/SelectionToolbar'
import { RestoreToastLayer } from './components/RestoreToast'
import { ToastLayer } from './components/ToastLayer'
import { UnlockScreen } from './components/UnlockScreen'
import { LoginWizard } from './components/LoginWizard'
import { AccountManager } from './components/AccountManager'
import { ConversationPicker } from './components/ConversationPicker'
import { LlmKeyDialog } from './components/LlmKeyDialog'
import { SettingsPanel } from './components/SettingsPanel'
import { TaskDetail } from './components/TaskDetail'
import { LogPanel } from './components/LogPanel'
import { Button, EmptyState, Spinner } from './components/primitives'
import { Icon, statusIcon } from './components/icons'

/** 首次配置的步骤 */
type WizardStep = 'none' | 'login' | 'conversations' | 'llm'

/** 当前打开了哪个浮层 */
interface Overlays {
  accountManager: boolean
  conversations: boolean
  llm: boolean
  settings: boolean
  logs: boolean
}

const CATEGORY_TITLE: Record<TaskStatus, { title: string; sub: string }> = {
  ongoing: { title: '进行中', sub: '已开始且未过截止时间的任务' },
  upcoming: { title: '未开始', sub: '还没到开始时间的任务' },
  done: { title: '已完成', sub: '由你人工确认完成的任务' },
  expired: { title: '已过期', sub: '已超过截止时间的任务' },
  // 更新需求 §4：删除不再是真的删除，而是移到这里等用户决定要不要恢复
  deleted: { title: '已删除', sub: '已移除的任务，可恢复；长按可彻底删除' }
}

export function App(): JSX.Element {
  /* ---------------- 全局状态 ---------------- */
  const [booting, setBooting] = useState(true)
  const [ready, setReady] = useState(false)
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [platforms, setPlatforms] = useState<PlatformDescriptor[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [layouts, setLayouts] = useState<TileLayout[]>([])
  const [probe, setProbe] = useState<SyncProbeResult | null>(null)

  const [category, setCategory] = useState<TaskStatus>('ongoing')
  const [keyword, setKeyword] = useState('')

  const [syncProgress, setSyncProgress] = useState<{
    state: string
    message: string
    progress?: number
    messagesRead: number
    currentConversation?: string
  }>({ state: 'idle', message: '尚未开始同步', messagesRead: 0 })

  const [wizard, setWizard] = useState<WizardStep>('none')
  const [overlays, setOverlays] = useState<Overlays>({
    accountManager: false,
    conversations: false,
    llm: false,
    settings: false,
    logs: false
  })
  const [detailTask, setDetailTask] = useState<Task | null>(null)
  const [extracting, setExtracting] = useState(false)
  /** 手动新建任务（第二次更新需求 §1a）的进行中标志 */
  const [newTaskBusy, setNewTaskBusy] = useState(false)

  /* ---------------- 多选与恢复提示（更新需求 §3 / §4） ---------------- */

  /** 是否处于多选模式 */
  const [selectionMode, setSelectionMode] = useState(false)
  /** 多选模式下已选中的任务 id */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  /**
   * 恢复成功的提示队列。
   * 队列与「最多同时堆叠 3 个」的规则交给 RestoreToastLayer 自己管，
   * 这里只负责往里 push——保持 App 的职责单纯。
   */
  const [restoreToasts, setRestoreToasts] = useState<{ id: number; taskName: string }[]>([])
  const restoreToastSeq = useRef(0)

  const pushRestoreToast = useCallback((taskName: string) => {
    const id = ++restoreToastSeq.current
    setRestoreToasts((prev) => [...prev, { id, taskName }])
  }, [])

  const dismissRestoreToast = useCallback((id: number) => {
    setRestoreToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  /** 首次配置流程只需判断一次，避免用户手动关掉向导后被反复弹出来 */
  const wizardInitialized = useRef(false)

  /* ---------------- 数据加载 ---------------- */

  const reloadTasks = useCallback(async () => {
    try {
      setTasks(await api.tasks({}))
    } catch (e) {
      // 任务列表加载失败通常是数据库还没就绪；记日志即可，不必打扰用户
      console.error('[app] 加载任务失败', e)
    }
  }, [])

  const reloadAccounts = useCallback(async () => {
    try {
      setAccounts(await api.accounts())
    } catch (e) {
      console.error('[app] 加载账号失败', e)
    }
  }, [])

  const reloadLayouts = useCallback(async () => {
    try {
      setLayouts(await api.layouts())
    } catch (e) {
      console.error('[app] 加载磁贴布局失败', e)
    }
  }, [])

  const reloadProbe = useCallback(async () => {
    try {
      setProbe(await api.syncProbe())
    } catch (e) {
      console.error('[app] 环境自检失败', e)
    }
  }, [])

  /** 一次性把业务数据全部读回来 */
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadTasks(), reloadAccounts(), reloadLayouts()])
    void reloadProbe()
  }, [reloadTasks, reloadAccounts, reloadLayouts, reloadProbe])

  /* ---------------- 启动 ---------------- */

  useEffect(() => {
    let cancelled = false

    const boot = async (): Promise<void> => {
      try {
        const [appInfo, vaultStatus, appSettings, platformList] = await Promise.all([
          api.appInfo(),
          api.vaultStatus(),
          api.getSettings(),
          api.platforms()
        ])
        if (cancelled) return

        setInfo(appInfo)
        setVault(vaultStatus)
        setSettings(appSettings)
        setPlatforms(platformList)

        // 界面缩放立即生效（需求：适配高分屏，观感优雅）
        document.documentElement.dataset.uiScale = String(appSettings.uiScale)

        if (vaultStatus.unlocked) {
          setReady(true)
          await reloadAll()
        }
      } catch (e) {
        toastError(e, '应用初始化失败')
      } finally {
        if (!cancelled) setBooting(false)
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [reloadAll])

  /* ---------------- 订阅主进程事件 ---------------- */

  useEffect(() => {
    const offProgress = on('sync:progress', (p) => {
      setSyncProgress(p)
    })
    const offTasks = on('tasks:changed', () => {
      void reloadTasks()
    })
    const offAccounts = on('accounts:changed', (list) => {
      setAccounts(list)
    })
    return () => {
      offProgress()
      offTasks()
      offAccounts()
    }
  }, [reloadTasks])

  /* ---------------- 状态自动重分类的界面侧兜底 ----------------
   * 主进程在每次 task:list 时已经重分类过一次；这里再加一个低频轮询，
   * 用于「用户一直停在某个类别页不动」时也能看到任务从"进行中"翻成"已过期"。
   */
  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => {
      void reloadTasks()
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [ready, reloadTasks])

  /* ---------------- 首次配置流程 ---------------- */

  useEffect(() => {
    if (!ready || wizardInitialized.current) return
    wizardInitialized.current = true
    // 一个账号都没有 → 从登录开始；有账号但没勾选会话 → 选会话；都没有问题 → 不弹
    if (accounts.length === 0) setWizard('login')
  }, [ready, accounts])

  /* ---------------- 派生数据 ---------------- */

  const counts = useMemo(() => {
    // 注意「已删除」也要出现在这里（更新需求 §4 新增的分类）
    const out: Record<TaskStatus, number> = {
      ongoing: 0,
      upcoming: 0,
      done: 0,
      expired: 0,
      deleted: 0
    }
    for (const t of tasks) {
      if (t.status in out) out[t.status] += 1
    }
    return out
  }, [tasks])

  const visibleTasks = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return tasks
      .filter((t) => t.status === category)
      .filter((t) => {
        if (!kw) return true
        return (
          t.name.toLowerCase().includes(kw) ||
          (t.topic ?? '').toLowerCase().includes(kw) ||
          (t.type ?? '').toLowerCase().includes(kw) ||
          (t.originalText ?? '').toLowerCase().includes(kw)
        )
      })
  }, [tasks, category, keyword])

  /** 当前分类是不是「已删除」——决定磁贴是可恢复还是可完成/删除 */
  const isDeletedTab = category === 'deleted'

  /* ---------------- 操作 ---------------- */

  const handleStartSync = useCallback(async () => {
    try {
      await api.syncStart()
      toast('info', '已开始实时同步，会按设定的间隔定时读取聊天记录')
    } catch (e) {
      toastError(e, '启动同步失败')
    }
  }, [])

  const handleStopSync = useCallback(async () => {
    try {
      await api.syncStop()
      toast('info', '已停止实时同步')
    } catch (e) {
      toastError(e, '停止同步失败')
    }
  }, [])

  /**
   * 抽取任务（手动触发）。
   *
   * ⚠️ 手动点击时传 `full: true`（重新扫描每个会话最近的一批消息），
   * 而不是走增量游标。原因：
   *   - 增量模式只处理「游标之后的新消息」，一条消息**只会被送进模型一次**；
   *     如果那一次模型没抽出来（上下文不足、返回空等），这条消息就再也不会被看了。
   *   - 手动点「抽取任务」的用户意图正是「再帮我看一遍」，
   *     所以这里重扫最近记录，把之前漏掉的任务找回来。
   * 后台自动同步走的仍是增量（见 sync-service），不会重复烧 token。
   */
  const handleExtract = useCallback(async () => {
    setExtracting(true)
    try {
      const report = await api.taskExtract({ full: true })
      if (report.failures.length > 0) {
        toast(
          'warn',
          `抽取完成：新建 ${report.tasksCreated} 个、合并 ${report.tasksMerged} 个，${report.failures.length} 个会话失败（详见日志）`
        )
      } else {
        toast('ok', `抽取完成：新建 ${report.tasksCreated} 个、合并 ${report.tasksMerged} 个`)
      }
      await reloadTasks()
    } catch (e) {
      toastError(e, '抽取任务失败')
    } finally {
      setExtracting(false)
    }
  }, [reloadTasks])

  /**
   * 手动新增任务（第二次更新需求 §1a）。
   * 先建一条空白的 manual 任务，再直接打开详情面板让用户填写；
   * 若名称/主题留空，详情面板保存时会调用 AI 生成（见 TaskDetail）。
   */
  const handleNewTask = useCallback(async () => {
    setNewTaskBusy(true)
    try {
      const task = await api.taskCreate()
      await reloadTasks()
      setDetailTask(task)
      toast('info', '已新建任务，请在右侧面板填写信息；名称/主题留空可由 AI 生成')
    } catch (e) {
      toastError(e, '新建任务失败')
    } finally {
      setNewTaskBusy(false)
    }
  }, [reloadTasks])

  const handleComplete = useCallback(
    async (task: Task) => {
      try {
        await api.taskSetStatus(task.id, 'done')
        toast('ok', `已标记完成：${task.name}`)
        await reloadTasks()
      } catch (e) {
        toastError(e, '标记完成失败')
      }
    },
    [reloadTasks]
  )

  /**
   * 删除 = **移入「已删除」分类**（更新需求 §4），不是彻底删除。
   * 这样用户误删还能从「已删除」里恢复。
   */
  const handleDelete = useCallback(
    async (task: Task) => {
      try {
        await api.taskDelete(task.id)
        toast('ok', `已移入「已删除」：${task.name}`)
        if (detailTask?.id === task.id) setDetailTask(null)
        await reloadTasks()
      } catch (e) {
        toastError(e, '删除失败')
      }
    },
    [reloadTasks, detailTask]
  )

  /**
   * 从「已删除」恢复（点击即生效，无需确认）。
   * 恢复后按起止时间自动归类，并弹一个带倒数进度条的绿色提示（更新需求 §4）。
   */
  const handleRestore = useCallback(
    async (task: Task) => {
      try {
        const restored = await api.taskRestore(task.id)
        pushRestoreToast(restored.name)
        await reloadTasks()
      } catch (e) {
        toastError(e, '恢复失败')
      }
    },
    [reloadTasks]
  )

  /** 彻底删除——只在「已删除」分类里、经过磁贴上的二次确认后调用 */
  const handlePurge = useCallback(
    async (task: Task) => {
      try {
        await api.taskPurge(task.id)
        toast('warn', `已彻底删除（不可恢复）：${task.name}`)
        if (detailTask?.id === task.id) setDetailTask(null)
        await reloadTasks()
      } catch (e) {
        toastError(e, '彻底删除失败')
      }
    },
    [reloadTasks, detailTask]
  )

  /* ---------------- 多选模式（更新需求 §3） ---------------- */

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }, [])

  const toggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  /** 长按磁贴进入多选，并把被长按的那条也选上（符合相册的手感） */
  const enterSelection = useCallback((taskId: string) => {
    setSelectionMode(true)
    setSelectedIds(new Set([taskId]))
  }, [])

  /** 批量操作后统一收尾：退出多选 + 刷新 */
  const runBatch = useCallback(
    async (action: 'delete' | 'restore' | 'purge') => {
      const ids = Array.from(selectedIds)
      if (ids.length === 0) return
      try {
        const r = await api.taskBatch(ids, action)
        const label = action === 'delete' ? '移入已删除' : action === 'restore' ? '恢复' : '彻底删除'
        toast(action === 'purge' ? 'warn' : 'ok', `已${label} ${r.affected} 个任务`)
        exitSelection()
        await reloadTasks()
      } catch (e) {
        toastError(e, '批量操作失败')
      }
    },
    [selectedIds, exitSelection, reloadTasks]
  )

  /**
   * 一键清除当前分类（更新需求 §3）。
   * 只清这个分类，**不动账号、不动 API Key、不动其它分类**。
   * 「已删除」分类走彻底删除（磁贴那边已经做过 3 秒长按 + 二次确认）。
   */
  const handleClearCategory = useCallback(async () => {
    try {
      const r = await api.taskClearCategory(category, isDeletedTab)
      toast('warn', `已清除「${CATEGORY_TITLE[category].title}」下的 ${r.affected} 个任务`)
      exitSelection()
      await reloadTasks()
    } catch (e) {
      toastError(e, '一键清除失败')
    }
  }, [category, isDeletedTab, exitSelection, reloadTasks])

  const handleLayoutChange = useCallback(
    async (next: TileLayout[]) => {
      // 只保留当前类别里的布局，与库里其它类别的位置合并
      const others = layouts.filter((l) => l.status !== category)
      const merged = [...others, ...next]
      setLayouts(merged)
      try {
        await api.setLayouts(merged)
      } catch (e) {
        // 布局保存失败不打断交互，只提示
        toastError(e, '保存磁贴排列失败')
      }
    },
    [layouts, category]
  )

  /** 一键装载演示数据：让用户在没有任何微信环境时也能立刻看到完整界面 */
  const handleSeedDemo = useCallback(async () => {
    try {
      const res = await api.mockSeed(true)
      await reloadAll()
      toast('ok', `已装载演示数据：${res.conversations} 个会话、抽取到 ${res.tasks} 个任务`)
      setWizard('none')
    } catch (e) {
      toastError(e, '装载演示数据失败')
    }
  }, [reloadAll])

  /* ---------------- 渲染 ---------------- */

  if (booting) {
    return (
      <div className="lock-screen">
        <div className="col" style={{ alignItems: 'center', gap: 14 }}>
          <Spinner size={26} />
          <div className="text-secondary">正在启动…</div>
        </div>
      </div>
    )
  }

  // 保险库未解锁：先解锁，否则什么都读不到
  if (vault && !vault.unlocked) {
    return (
      <>
        <UnlockScreen
          status={vault}
          onUnlocked={async (next) => {
            setVault(next)
            setReady(true)
            await reloadAll()
          }}
        />
        <ToastLayer />
      </>
    )
  }

  const cat = CATEGORY_TITLE[category]
  const CatIcon = statusIcon(category)

  return (
    <div className="app">
      <TopBar
        keyword={keyword}
        onKeywordChange={setKeyword}
        syncProgress={syncProgress as never}
        syncing={syncProgress.state !== 'idle' && syncProgress.state !== 'stopped' && syncProgress.state !== 'error'}
        onStartSync={() => void handleStartSync()}
        onStopSync={() => void handleStopSync()}
        onExtract={() => void handleExtract()}
        extracting={extracting}
        onNewTask={() => void handleNewTask()}
        newTaskBusy={newTaskBusy}
        accounts={accounts}
        platforms={platforms}
        onOpenAccountManager={() => setOverlays((o) => ({ ...o, accountManager: true }))}
      />

      <div className="app-body">
        <CategorySidebar
          active={category}
          counts={counts}
          onChange={setCategory}
          onOpenConversations={() => setOverlays((o) => ({ ...o, conversations: true }))}
          onOpenLlmKeys={() => setOverlays((o) => ({ ...o, llm: true }))}
          onOpenSettings={() => setOverlays((o) => ({ ...o, settings: true }))}
          onOpenLogs={() => setOverlays((o) => ({ ...o, logs: true }))}
          pendingHint={{ conversations: accounts.length > 0 && counts.ongoing + counts.upcoming === 0, llm: settings?.activeLlm == null }}
        />

        <main className="board">
          <div className="board-head">
            <CatIcon size={22} />
            <div className="col">
              <div className="board-title">{cat.title}</div>
              <div className="board-sub">
                {cat.sub} · 共 {visibleTasks.length} 个
                {keyword ? `（搜索「${keyword}」）` : ''}
              </div>
            </div>
            {/* 多选入口：除了长按磁贴，也给一个显式按钮（键盘/鼠标用户友好） */}
            {visibleTasks.length > 0 && !selectionMode && (
              <Button
                size="sm"
                variant="subtle"
                onClick={() => {
                  setSelectionMode(true)
                  setSelectedIds(new Set())
                }}
                title="进入多选模式，可批量清除或恢复"
              >
                <Icon.Check size={14} />
                多选
              </Button>
            )}
          </div>

          {/* 多选模式的工具栏（更新需求 §3） */}
          {selectionMode && (
            <SelectionToolbar
              status={category}
              selectedCount={selectedIds.size}
              totalCount={visibleTasks.length}
              onSelectAll={() => setSelectedIds(new Set(visibleTasks.map((t) => t.id)))}
              onSelectNone={() => setSelectedIds(new Set())}
              onInvert={() =>
                setSelectedIds((prev) => {
                  const next = new Set<string>()
                  for (const t of visibleTasks) if (!prev.has(t.id)) next.add(t.id)
                  return next
                })
              }
              onBatchDelete={() => void runBatch('delete')}
              onBatchRestore={() => void runBatch('restore')}
              onBatchPurge={() => void runBatch('purge')}
              onClearCategory={() => void handleClearCategory()}
              onExitSelection={exitSelection}
            />
          )}

          {visibleTasks.length === 0 ? (
            <EmptyState
              icon={Icon.Grid}
              title={keyword ? '没有匹配的任务' : `「${cat.title}」里还没有任务`}
              description={
                keyword ? (
                  '试试换个关键词，或清空搜索框。'
                ) : tasks.length === 0 ? (
                  <span style={{ lineHeight: 2 }}>
                    还没有任何任务。可以：
                    <br />① 在「设置 → 数据来源」里<strong>装载演示数据</strong>，立刻看到完整界面；
                    <br />② 添加账号并勾选联系人与群聊后点「抽取任务」；
                    <br />③ 也可以点右上角「抽取任务」用已有的聊天记录重新抽取一次。
                  </span>
                ) : (
                  `其它类别里有 ${tasks.length - visibleTasks.length} 个任务，切换左侧类别查看。`
                )
              }
              action={
                tasks.length === 0 ? (
                  <div className="row gap-sm">
                    <Button variant="primary" onClick={() => void handleSeedDemo()}>
                      <Icon.Sparkles size={14} />
                      装载演示数据
                    </Button>
                    <Button
                      variant="subtle"
                      onClick={() => setOverlays((o) => ({ ...o, conversations: true }))}
                    >
                      <Icon.Users size={14} />
                      选择联系人与群聊
                    </Button>
                  </div>
                ) : null
              }
            />
          ) : (
            <TileGrid
              tasks={visibleTasks}
              layouts={layouts}
              mode={isDeletedTab ? 'deleted' : 'normal'}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onEnterSelection={enterSelection}
              onOpen={(t) => setDetailTask(t)}
              onComplete={(t) => void handleComplete(t)}
              onDelete={(t) => void handleDelete(t)}
              onRestore={(t) => void handleRestore(t)}
              onPurge={(t) => void handlePurge(t)}
              onLayoutChange={(l) => void handleLayoutChange(l)}
            />
          )}
        </main>
      </div>

      {/* 恢复成功的提示（更新需求 §4）：页面**上方中部**，可叠 3 个，不阻塞操作 */}
      <RestoreToastLayer items={restoreToasts} onDismiss={dismissRestoreToast} />

      {/* ---------------- 浮层 ---------------- */}

      <LoginWizard
        open={wizard === 'login'}
        firstRun
        onClose={() => setWizard('none')}
        onAccountsChanged={() => void reloadAccounts()}
        onFinish={() => setWizard('conversations')}
        onCancel={() => {
          // 需求：登录过程中点「取消」应退出该软件
          window.close()
        }}
      />

      <ConversationPicker
        open={wizard === 'conversations' || overlays.conversations}
        firstRun={wizard === 'conversations'}
        accounts={accounts}
        onClose={() => {
          setWizard(wizard === 'conversations' ? 'none' : wizard)
          setOverlays((o) => ({ ...o, conversations: false }))
        }}
        onConfirmed={() => {
          void reloadTasks()
          if (wizard === 'conversations') setWizard('llm')
          setOverlays((o) => ({ ...o, conversations: false }))
        }}
      />

      <LlmKeyDialog
        open={wizard === 'llm' || overlays.llm}
        firstRun={wizard === 'llm'}
        onClose={() => {
          if (wizard === 'llm') setWizard('none')
          setOverlays((o) => ({ ...o, llm: false }))
        }}
        onChanged={async () => {
          setSettings(await api.getSettings())
        }}
      />

      <AccountManager
        open={overlays.accountManager}
        onClose={() => setOverlays((o) => ({ ...o, accountManager: false }))}
        accounts={accounts}
        platforms={platforms}
        onChanged={() => void reloadAccounts()}
        onAddAccount={() => {
          setOverlays((o) => ({ ...o, accountManager: false }))
          setWizard('login')
        }}
      />

      <TaskDetail
        open={detailTask !== null}
        task={detailTask}
        accounts={accounts}
        onClose={() => setDetailTask(null)}
        onChanged={() => {
          void reloadTasks()
          // 详情里的改动要同步回抽屉里正在展示的任务对象
          if (detailTask) {
            void api.taskGet(detailTask.id).then((t) => setDetailTask(t))
          }
        }}
      />

      {settings && (
        <SettingsPanel
          open={overlays.settings}
          onClose={() => setOverlays((o) => ({ ...o, settings: false }))}
          settings={settings}
          onSettingsChanged={(next) => {
            setSettings(next)
            document.documentElement.dataset.uiScale = String(next.uiScale)
          }}
          vault={vault ?? {
            initialized: true,
            unlocked: true,
            autoUnlock: false,
            kdf: {
              algorithm: 'PBKDF2-HMAC-SHA512',
              iterations: 0,
              keyLength: 32,
              cipher: 'AES-256-GCM',
              saltLength: 16
            }
          }}
          onVaultChanged={(next) => {
            setVault(next)
            if (!next.unlocked) {
              // 被锁定后界面要退回解锁页
              setReady(false)
            }
          }}
          probe={probe}
          onProbeRefresh={() => void reloadProbe()}
        />
      )}

      <LogPanel open={overlays.logs} onClose={() => setOverlays((o) => ({ ...o, logs: false }))} />

      <ToastLayer />

      {/* 应用版本号：右下角极小的水印，方便确认自己跑的是哪一版 */}
      {info && (
        <div
          className="text-xs text-tertiary"
          style={{
            position: 'fixed',
            right: 10,
            bottom: 6,
            pointerEvents: 'none',
            opacity: 0.45,
            fontFamily: 'var(--font-mono)'
          }}
        >
          v{info.version} · {info.packaged ? '打包版' : '开发版'}
        </div>
      )}
    </div>
  )
}
