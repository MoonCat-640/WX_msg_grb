/**
 * 设置面板
 * ------------------------------------------------------------------
 * 分 4 个页签：数据来源 / 同步 / 界面 / 安全。
 * 所有改动都通过 api.patchSettings 落库后回传 onSettingsChanged，
 * 外壳据此刷新（界面缩放则额外立即写 documentElement.dataset.uiScale）。
 *
 * 取舍说明：
 *  - 路径、数字这类输入框采用「本地草稿 + 保存按钮」，避免用户每敲一个字符
 *    就触发一次 IPC 写盘；开关类则即改即存（心智负担低，且失败会自动回滚）。
 *  - 「清空全部数据」是破坏性操作，用内联二次确认（不用 window.confirm）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type {
  AppInfo,
  AppSettings,
  LogLevel,
  PlatformLoginState,
  SyncProgress,
  SyncState,
  VaultStatus
} from '@shared/types'
import type { SyncProbeResult } from '@shared/ipc'
import { api, on, toast, toastError, tryCall } from '../api'
import type { SettingsPanelProps } from './contracts'
import { Button, Field, Modal, ProgressBar, Select, Tabs, Toggle } from './primitives'
import type { SelectOption, TabItem } from './primitives'
import { Icon } from './icons'

type SetTab = 'data' | 'sync' | 'tray' | 'ui' | 'security'

const TAB_ITEMS: TabItem<SetTab>[] = [
  { key: 'data', label: '数据来源' },
  { key: 'sync', label: '同步' },
  // 托盘与后台运行（第二次更新需求 §3）
  { key: 'tray', label: '托盘与后台' },
  { key: 'ui', label: '界面' },
  { key: 'security', label: '安全' }
]

/** 数据后端 → 中文说明 */
const BACKEND_LABEL: Record<SyncProbeResult['backend'], string> = {
  'wechat-exp-service': 'wechat_exp 本地服务',
  'wechat-exp-cli': 'wechat_exp 命令行',
  mock: '模拟数据模式',
  none: '未就绪'
}

/** 同步状态 → 中文 */
const SYNC_STATE_LABEL: Record<SyncState, string> = {
  idle: '空闲',
  scanning: '扫描中',
  decrypting: '解密中',
  reading: '读取中',
  error: '出错',
  stopped: '已停止'
}

const UI_SCALE_OPTIONS: SelectOption<string>[] = [
  { value: '0.9', label: '90%' },
  { value: '1', label: '100%（默认）' },
  { value: '1.1', label: '110%' },
  { value: '1.25', label: '125%' },
  { value: '1.4', label: '140%' }
]

const LOG_LEVEL_OPTIONS: SelectOption<LogLevel>[] = [
  { value: 'debug', label: 'debug（最详细）' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error（最精简）' }
]

/**
 * 从路径里取出「所在目录」。
 * 以「带扩展名的文件名」结尾时截到父目录，否则认为传进来本身就是目录。
 * 因为 api.openPath 只能打开已存在的路径，必须给目录而不是 exe 文件路径。
 */
function dirOf(p: string): string {
  const s = p.trim()
  if (!s) return ''
  return /[\\/][^\\/]+\.[A-Za-z0-9]{1,6}$/.test(s) ? s.replace(/[\\/][^\\/]+$/, '') : s
}

export function SettingsPanel({
  open,
  onClose,
  settings,
  onSettingsChanged,
  vault,
  onVaultChanged,
  probe,
  onProbeRefresh
}: SettingsPanelProps): JSX.Element {
  const [tab, setTab] = useState<SetTab>('data')

  const [localProbe, setLocalProbe] = useState<SyncProbeResult | null>(probe)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)

  // 各类「草稿」输入
  const [expPath, setExpPath] = useState('')
  const [dbDir, setDbDir] = useState('')
  const [intervalSec, setIntervalSec] = useState('30')
  const [lookbackDays, setLookbackDays] = useState('0')
  const [ioTimeoutSec, setIoTimeoutSec] = useState('30')

  // 托盘与后台（第二次更新需求 §3）
  const [qqflowPath, setQqflowPath] = useState('')
  const [loginStates, setLoginStates] = useState<PlatformLoginState[]>([])
  const [qqflowProbe, setQqflowProbe] = useState<{ found: boolean; path?: string } | null>(null)

  // 安全页草稿
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [newPwd2, setNewPwd2] = useState('')
  const [autoUnlock, setAutoUnlock] = useState(vault.autoUnlock)

  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)

  // 外壳刷新后传回新的自检结果时同步到本地
  useEffect(() => {
    if (probe) setLocalProbe(probe)
  }, [probe])

  // 打开面板：把 props 里的设置复制成本地草稿（关掉再开时丢弃未保存的改动）
  useEffect(() => {
    if (!open) return
    setTab('data')
    setExpPath(settings.wechatExpPath)
    setDbDir(settings.dbStorageDir)
    setIntervalSec(String(Math.round(settings.sync.intervalMs / 1000)))
    setLookbackDays(String(settings.sync.lookbackDays))
    setIoTimeoutSec(String(Math.round(settings.ioTimeoutMs / 1000)))
    setQqflowPath(settings.qqflowPath)
    setAutoUnlock(vault.autoUnlock)
    setOldPwd('')
    setNewPwd('')
    setNewPwd2('')
    setConfirmClear(false)
    setBusy(false)
    // 只在打开时初始化一次草稿；面板打开期间 settings/vault 的外部变化不覆盖用户输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 自检结果：外壳没给（null）就自己拉一次
  useEffect(() => {
    if (!open || localProbe) return
    let cancelled = false
    api
      .syncProbe()
      .then((p) => {
        if (!cancelled) setLocalProbe(p)
      })
      .catch((e) => {
        if (!cancelled) toastError(e, '数据来源自检失败')
      })
    return () => {
      cancelled = true
    }
  }, [open, localProbe])

  // 应用版本信息（界面页展示 + 日志目录按钮需要）
  useEffect(() => {
    if (!open || appInfo) return
    let cancelled = false
    api
      .appInfo()
      .then((v) => {
        if (!cancelled) setAppInfo(v)
      })
      .catch((e) => {
        if (!cancelled) toastError(e, '读取应用信息失败')
      })
    return () => {
      cancelled = true
    }
  }, [open, appInfo])

  // 同步进度：先拉一次当前状态，再订阅主进程推送
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .syncStatus()
      .then((p) => {
        if (!cancelled) setSyncProgress(p)
      })
      .catch(() => {
        /* 状态拉不到不弹错，后续推送会补上 */
      })
    const off = on('sync:progress', (p) => setSyncProgress(p))
    return () => {
      cancelled = true
      off() // 必须退订，否则面板反复开关会累积监听
    }
  }, [open])

  /* ---------------- 托盘页：登录状态 + QQFlow（第二次更新需求 §3/§5） ---------------- */

  /** 刷新「平台登录状态」与「QQFlow 是否就位」两项信息 */
  const refreshTrayInfo = useCallback(async (): Promise<void> => {
    const [states, found] = await Promise.all([
      tryCall(() => api.platformLoginState(), '读取平台登录状态失败'),
      tryCall(() => api.qqProbeQqflow(), '探测 QQFlow 失败')
    ])
    if (states) setLoginStates(states)
    if (found) setQqflowProbe(found)
  }, [])

  useEffect(() => {
    if (!open || tab !== 'tray') return
    void refreshTrayInfo()
    // 打开该页期间每 10 秒刷新一次（本地 tasklist 探测，开销很小且能反映"刚登录"）
    const timer = window.setInterval(() => void refreshTrayInfo(), 10_000)
    return () => window.clearInterval(timer)
  }, [open, tab, refreshTrayInfo])

  /** 统一保存设置：成功回传外壳，失败弹提示 */
  const applySettings = async (part: Partial<AppSettings>, okMsg?: string): Promise<void> => {
    try {
      const next = await api.patchSettings(part)
      onSettingsChanged(next)
      if (okMsg) toast('ok', okMsg)
    } catch (e) {
      toastError(e, '保存设置失败')
    }
  }

  /* ------------------------- 数据来源 ------------------------- */

  const openExpDir = async (): Promise<void> => {
    const dir = dirOf(expPath)
    if (!dir) {
      toast('warn', '请先填写 wechat_exp 路径')
      return
    }
    await tryCall(() => api.openPath(dir), '打开目录失败')
  }

  /** 打开 QQFlow（第二次更新需求 §2/§5）：纯 GUI 程序，只能启动进程 */
  const handleLaunchQqflow = async (): Promise<void> => {
    const r = await tryCall(() => api.qqLaunchQqflow(), '启动 QQFlow 失败')
    if (!r) return
    toast(r.launched ? 'ok' : 'warn', r.message)
    void refreshTrayInfo()
  }

  const seedDemo = async (): Promise<void> => {    setBusy(true)
    const res = await tryCall(() => api.mockSeed(false), '装载演示数据失败')
    if (res) {
      toast('ok', `已装载 ${res.tasks} 个任务、${res.conversations} 个会话`)
      const s = await tryCall(() => api.getSettings())
      if (s) onSettingsChanged(s)
    }
    setBusy(false)
  }

  const clearAll = async (): Promise<void> => {
    setBusy(true)
    const ok = await tryCall(
      async () => {
        await api.mockClear()
        return true
      },
      '清空数据失败'
    )
    if (ok) {
      toast('ok', '已清空全部数据')
      setConfirmClear(false)
      const s = await tryCall(() => api.getSettings())
      if (s) onSettingsChanged(s)
    }
    setBusy(false)
  }

  /* ------------------------- 同步 ------------------------- */

  const saveSync = async (): Promise<void> => {
    const sec = Number(intervalSec)
    const days = Number(lookbackDays)
    const timeout = Number(ioTimeoutSec)
    if (!Number.isFinite(sec) || sec <= 0) {
      toast('warn', '轮询间隔必须是大于 0 的数字')
      return
    }
    if (!Number.isFinite(days) || days < 0) {
      toast('warn', '回溯天数不能为负数')
      return
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      toast('warn', '超时时间必须是大于 0 的数字')
      return
    }
    setBusy(true)
    await applySettings(
      {
        sync: { ...settings.sync, intervalMs: Math.round(sec * 1000), lookbackDays: Math.floor(days) },
        ioTimeoutMs: Math.round(timeout * 1000)
      },
      '同步设置已保存'
    )
    setBusy(false)
  }

  const startSync = async (): Promise<void> => {
    setBusy(true)
    const p = await tryCall(() => api.syncStart(true), '启动同步失败')
    if (p) {
      setSyncProgress(p)
      toast('info', '已开始同步')
    }
    setBusy(false)
  }

  const stopSync = async (): Promise<void> => {
    setBusy(true)
    const p = await tryCall(() => api.syncStop(), '停止同步失败')
    if (p) {
      setSyncProgress(p)
      toast('info', '已请求停止同步')
    }
    setBusy(false)
  }

  /* ------------------------- 界面 ------------------------- */

  // 需求：界面缩放保存后立即生效
  const onScaleChange = async (v: string): Promise<void> => {
    document.documentElement.dataset.uiScale = v
    await applySettings({ uiScale: Number(v) }, '界面缩放已更新')
  }

  const openLogDir = async (): Promise<void> => {
    if (!appInfo) {
      toast('warn', '应用信息尚未加载完成，请稍后重试')
      return
    }
    await tryCall(() => api.openPath(appInfo.logDir), '打开日志目录失败')
  }

  /* ------------------------- 安全 ------------------------- */

  const submitPassword = async (): Promise<void> => {
    if (!oldPwd) {
      toast('warn', '请输入原主口令')
      return
    }
    if (newPwd.length < 6) {
      toast('warn', '新主口令至少 6 位')
      return
    }
    if (newPwd !== newPwd2) {
      toast('warn', '两次输入的新主口令不一致')
      return
    }
    setBusy(true)
    const next = await tryCall(
      () => api.vaultChangePassword({ oldPassword: oldPwd, newPassword: newPwd, autoUnlock }),
      '修改主口令失败'
    )
    if (next) {
      onVaultChanged(next)
      setOldPwd('')
      setNewPwd('')
      setNewPwd2('')
      toast('ok', '主口令已更新')
    }
    setBusy(false)
  }

  const lockNow = async (): Promise<void> => {
    setBusy(true)
    const next = await tryCall(() => api.vaultLock(), '锁定失败')
    if (next) {
      onVaultChanged(next)
      toast('ok', '保险库已锁定')
    }
    setBusy(false)
  }

  return (
    <Modal open={open} width={720} title="设置" onClose={onClose}>
      <div className="set-tabbar">
        <Tabs variant="underline" items={TAB_ITEMS} active={tab} onChange={setTab} />
      </div>

      {/* ==================== ① 数据来源 ==================== */}
      {tab === 'data' && (
        <>
          <section className="set-section">
            <div className="detail-label">环境自检</div>
            <div className="section-card set-kv">
              <div className="kv">
                <span className="kv-key">微信数据目录</span>
                <div className="kv-val mono text-xs">
                  {localProbe?.dbStorageDir || settings.dbStorageDir || '未检测到'}
                </div>
              </div>
              <div className="kv">
                <span className="kv-key">wechat_exp</span>
                <div className="kv-val">
                  {localProbe?.exePath
                    ? `${localProbe.exePath}${localProbe.exeVersion ? `（v${localProbe.exeVersion}）` : ''}`
                    : '未找到'}
                </div>
              </div>
              <div className="kv">
                <span className="kv-key">服务端口</span>
                <div className="kv-val">
                  {localProbe?.servicePort ?? (localProbe?.serviceRunning ? '运行中' : '未运行')}
                </div>
              </div>
              <div className="kv">
                <span className="kv-key">当前后端</span>
                <div className="kv-val">
                  {localProbe ? BACKEND_LABEL[localProbe.backend] : '自检中…'}
                </div>
              </div>
            </div>
            {localProbe && localProbe.notes.length > 0 && (
              <div className="set-notice-list">
                {localProbe.notes.map((n, i) => (
                  <div className="notice" key={i}>
                    <span className="notice-icon">
                      <Icon.Info size={15} />
                    </span>
                    <span>{n}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="set-actions">
              <Button size="sm" onClick={onProbeRefresh}>
                <Icon.Refresh size={14} /> 重新自检
              </Button>
            </div>
          </section>

          <section className="set-section">
            <div className="detail-label">wechat_exp 路径</div>
            <div className="set-input-row">
              <input
                className="grow"
                value={expPath}
                placeholder="留空则自动搜索，例如 D:/tools/wechat_exp.exe"
                onChange={(e) => setExpPath(e.target.value)}
              />
              <Button size="sm" onClick={() => void openExpDir()}>
                打开所在目录
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void applySettings({ wechatExpPath: expPath.trim() }, '已保存 wechat_exp 路径')}
              >
                保存
              </Button>
            </div>
            <div className="set-hint">
              wechat_exp 负责从微信进程提取密钥并解密数据库。「打开所在目录」只能打开已存在的目录。
            </div>
          </section>

          <section className="set-section">
            <div className="detail-label">微信数据目录（db_storage）</div>
            <div className="set-input-row">
              <input
                className="grow"
                value={dbDir}
                placeholder="留空则自动检测"
                onChange={(e) => setDbDir(e.target.value)}
              />
              <Button
                size="sm"
                variant="primary"
                onClick={() => void applySettings({ dbStorageDir: dbDir.trim() }, '已保存微信数据目录')}
              >
                保存
              </Button>
            </div>
            <div className="set-hint">
              留空则自动检测。可在微信「设置 → 文件管理 → 打开文件夹」里找到
              {' xwechat_files<账号>/db_storage'}
            </div>
          </section>

          <section className="set-section">
            <div className="detail-label">演示数据</div>
            <div className="section-card">
              <Toggle
                checked={settings.mockMode}
                onChange={(v) =>
                  void applySettings({ mockMode: v }, v ? '已开启模拟数据模式' : '已关闭模拟数据模式')
                }
                label="模拟数据模式"
                hint="开启后不读取真实微信数据，使用内置演示数据，便于在没有微信环境时体验界面。"
              />
              <div className="set-actions">
                <Button size="sm" disabled={busy} onClick={() => void seedDemo()}>
                  <Icon.Play size={13} /> 装载演示数据
                </Button>
                <div className="grow" />
                {confirmClear ? (
                  <div className="row td-confirm">
                    <span className="text-sm text-secondary">确认清空全部任务、会话与账号数据？</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmClear(false)}>
                      取消
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy}
                      disabled={busy}
                      onClick={() => void clearAll()}
                    >
                      确认清空
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmClear(true)}>
                    <Icon.Trash size={13} /> 清空全部数据
                  </Button>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      {/* ==================== ② 同步 ==================== */}
      {tab === 'sync' && (
        <>
          <section className="set-section">
            <div className="detail-label">同步配置</div>
            <div className="section-card">
              <Toggle
                checked={settings.sync.enabled}
                onChange={(v) =>
                  void applySettings(
                    { sync: { ...settings.sync, enabled: v } },
                    v ? '已开启实时同步' : '已关闭实时同步'
                  )
                }
                label="实时读取聊天记录"
                hint="开启后按下面的间隔定时调用微信数据接口，实时更新聊天记录。"
              />
              <div className="set-form">
                <Field label="轮询间隔（秒）" hint="需求默认 30 秒；建议不要小于 10 秒，避免频繁调用微信数据接口。">
                  <input
                    value={intervalSec}
                    inputMode="numeric"
                    onChange={(e) => setIntervalSec(e.target.value)}
                  />
                </Field>
                <Field label="回溯天数" hint="0 = 读取全部历史；正整数表示只读取最近 N 天。">
                  <input
                    value={lookbackDays}
                    inputMode="numeric"
                    onChange={(e) => setLookbackDays(e.target.value)}
                  />
                </Field>
                <Field label="外部调用超时（秒）" hint="调用微信数据接口、网络请求等的超时时间。">
                  <input
                    value={ioTimeoutSec}
                    inputMode="numeric"
                    onChange={(e) => setIoTimeoutSec(e.target.value)}
                  />
                </Field>
              </div>
              <div className="set-actions">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveSync()}>
                  保存同步设置
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void startSync()}>
                  <Icon.Play size={13} /> 立即同步一次
                </Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void stopSync()}>
                  <Icon.Stop size={13} /> 停止同步
                </Button>
              </div>
            </div>
          </section>

          <section className="set-section">
            <div className="detail-label">当前进度</div>
            <div className="section-card set-kv">
              <div className="kv">
                <span className="kv-key">状态</span>
                <div className="kv-val">
                  {syncProgress ? SYNC_STATE_LABEL[syncProgress.state] : '—'}
                </div>
              </div>
              <div className="kv">
                <span className="kv-key">说明</span>
                <div className="kv-val">{syncProgress?.message || '—'}</div>
              </div>
              <div className="kv">
                <span className="kv-key">已读消息</span>
                <div className="kv-val">{syncProgress ? syncProgress.messagesRead : '—'}</div>
              </div>
              <div className="kv">
                <span className="kv-key">当前会话</span>
                <div className="kv-val ellipsis">{syncProgress?.currentConversation || '—'}</div>
              </div>
            </div>
            {typeof syncProgress?.progress === 'number' && (
              <div className="set-progress">
                <ProgressBar value={syncProgress.progress} />
              </div>
            )}
          </section>
        </>
      )}

      {/* ==================== ③ 界面 ==================== */}
      {/* ---------------- 托盘与后台（第二次更新需求 §3） ---------------- */}
      {tab === 'tray' && (
        <>
          <section className="set-section">
            <div className="detail-label">系统托盘与后台运行</div>
            <div className="section-card set-kv">
              <Toggle
                checked={settings.tray.enabled}
                onChange={(v) =>
                  void applySettings(
                    { tray: { ...settings.tray, enabled: v } },
                    v ? '已启用系统托盘' : '已关闭系统托盘'
                  )
                }
                label="启用系统托盘"
                hint="在任务栏右下角常驻图标，随时唤出主窗口"
              />
              <Toggle
                checked={settings.tray.closeToTray}
                disabled={!settings.tray.enabled}
                onChange={(v) =>
                  void applySettings(
                    { tray: { ...settings.tray, closeToTray: v } },
                    v ? '关闭窗口将最小化到托盘' : '关闭窗口将退出软件'
                  )
                }
                label="关闭窗口时最小化到托盘"
                hint="软件继续驻留后台，同步与登录监听不中断"
              />
              <Toggle
                checked={settings.tray.backgroundCapture}
                onChange={(v) =>
                  void applySettings(
                    { tray: { ...settings.tray, backgroundCapture: v } },
                    v ? '已开启后台持续捕获' : '已关闭后台持续捕获'
                  )
                }
                label="后台持续捕获"
                hint="监听微信/QQ 登录状态；检测到登录且 QQFlow 已提取过密钥时自动导入（不会自动弹窗）"
              />
            </div>
          </section>

          <section className="set-section">
            <div className="detail-label">平台登录状态</div>
            <div className="section-card set-kv">
              {loginStates.length === 0 ? (
                <div className="text-tertiary text-sm">正在探测…</div>
              ) : (
                loginStates.map((s) => (
                  <div className="kv" key={s.platform}>
                    <span className="kv-key">{s.platform === 'qq' ? 'QQ' : '微信'}</span>
                    <div className="kv-val">
                      <span style={{ color: s.running ? 'var(--ok)' : 'var(--text-tertiary)' }}>
                        {s.running ? '运行中' : '未运行'}
                      </span>
                      <span className="text-xs text-tertiary"> · {s.message}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="set-actions">
              <Button size="sm" onClick={() => void refreshTrayInfo()}>
                <Icon.Refresh size={14} /> 重新探测
              </Button>
            </div>
          </section>

          <section className="set-section">
            <div className="detail-label">QQFlow（QQ 密钥提取工具）</div>
            <div className="section-card set-kv">
              <div className="kv">
                <span className="kv-key">是否就位</span>
                <div className="kv-val mono text-xs">
                  {qqflowProbe === null
                    ? '探测中…'
                    : qqflowProbe.found
                      ? qqflowProbe.path
                      : '未找到'}
                </div>
              </div>
            </div>
            <div className="notice">
              <span className="notice-icon">
                <Icon.Info size={15} />
              </span>
              <span>
                QQFlow 是第三方开源工具，<strong>不随本软件分发</strong>。请前往
                https://github.com/yfgug/QQFlow 下载后放到软件目录的 tools\ 下，或在下方手动指定路径。
                本软件只能"启动它"——密钥提取需要你在 QQFlow 自己的窗口里完成。
              </span>
            </div>
            <div className="set-input-row">
              <input
                className="grow"
                value={qqflowPath}
                placeholder="留空则自动搜索，例如 D:/tools/QQFlow.exe"
                onChange={(e) => setQqflowPath(e.target.value)}
              />
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  void applySettings({ qqflowPath: qqflowPath.trim() }, '已保存 QQFlow 路径')
                }
              >
                保存
              </Button>
            </div>
            <div className="set-actions">
              <Button size="sm" onClick={() => void handleLaunchQqflow()}>
                <Icon.Play size={14} /> 打开 QQFlow
              </Button>
            </div>
          </section>
        </>
      )}

      {tab === 'ui' && (
        <>
          <section className="set-section">
            <div className="detail-label">界面</div>
            <div className="section-card">
              <Field label="界面缩放" hint="用于 2560×1600 等高分辨率屏幕，保存后立即生效。">
                <Select
                  value={String(settings.uiScale)}
                  options={UI_SCALE_OPTIONS}
                  onChange={(v) => void onScaleChange(v)}
                />
              </Field>
              <Field label="日志级别" hint="低于该级别的日志不会写入日志文件。">
                <Select<LogLevel>
                  value={settings.logLevel}
                  options={LOG_LEVEL_OPTIONS}
                  onChange={(v) => void applySettings({ logLevel: v }, '日志级别已更新')}
                />
              </Field>
              <div className="set-actions">
                <Button size="sm" onClick={() => void openLogDir()}>
                  <Icon.Folder size={14} /> 打开日志目录
                </Button>
              </div>
            </div>
          </section>

          <section className="set-section">
            <div className="detail-label">版本信息</div>
            <div className="section-card set-kv">
              <div className="kv">
                <span className="kv-key">应用</span>
                <div className="kv-val">
                  {appInfo ? `${appInfo.name} ${appInfo.version}` : '加载中…'}
                </div>
              </div>
              <div className="kv">
                <span className="kv-key">Electron</span>
                <div className="kv-val mono">{appInfo?.electron ?? '—'}</div>
              </div>
              <div className="kv">
                <span className="kv-key">Node</span>
                <div className="kv-val mono">{appInfo?.node ?? '—'}</div>
              </div>
              <div className="kv">
                <span className="kv-key">Chrome</span>
                <div className="kv-val mono">{appInfo?.chrome ?? '—'}</div>
              </div>
              <div className="kv">
                <span className="kv-key">日志目录</span>
                <div className="kv-val mono text-xs">{appInfo?.logDir ?? '—'}</div>
              </div>
            </div>
          </section>
        </>
      )}

      {/* ==================== ④ 安全 ==================== */}
      {tab === 'security' && (
        <>
          <section className="set-section">
            <div className="detail-label">保险库状态</div>
            <div className="section-card set-kv">
              <div className="kv">
                <span className="kv-key">初始化</span>
                <div className="kv-val">{vault.initialized ? '已初始化' : '未初始化'}</div>
              </div>
              <div className="kv">
                <span className="kv-key">解锁状态</span>
                <div className="kv-val">{vault.unlocked ? '已解锁' : '已锁定'}</div>
              </div>
              <div className="kv">
                <span className="kv-key">自动解锁</span>
                <div className="kv-val">
                  {vault.autoUnlock ? '已开启（Windows 凭据管理）' : '已关闭'}
                </div>
              </div>
              <div className="kv">
                <span className="kv-key">KDF 算法</span>
                <div className="kv-val mono">{vault.kdf.algorithm}</div>
              </div>
              <div className="kv">
                <span className="kv-key">迭代次数</span>
                <div className="kv-val mono">{vault.kdf.iterations.toLocaleString()}</div>
              </div>
              <div className="kv">
                <span className="kv-key">密钥长度</span>
                <div className="kv-val mono">{vault.kdf.keyLength} 位</div>
              </div>
              <div className="kv">
                <span className="kv-key">加密算法</span>
                <div className="kv-val mono">{vault.kdf.cipher}</div>
              </div>
              <div className="kv">
                <span className="kv-key">盐长度</span>
                <div className="kv-val mono">{vault.kdf.saltLength} 字节</div>
              </div>
            </div>
            <div className="set-hint">
              账号信息、API Key、聊天数据均以此密钥加密后落盘；数据库文件整体加密。
            </div>
          </section>

          <div className="notice notice-warn">
            <span className="notice-icon">
              <Icon.Warn size={15} />
            </span>
            <span>
              自动解锁依赖 Windows 凭据管理（DPAPI）。关闭后每次启动都需要手动输入主口令，安全性更高。首次运行时的随机主口令是自动生成的，建议改成自己记得的口令。
            </span>
          </div>

          <section className="set-section set-section-gap">
            <div className="detail-label">修改主口令</div>
            <div className="section-card">
              <Field label="原主口令" required>
                <input
                  type="password"
                  value={oldPwd}
                  autoComplete="current-password"
                  onChange={(e) => setOldPwd(e.target.value)}
                />
              </Field>
              <Field label="新主口令" required hint="至少 6 位。">
                <input
                  type="password"
                  value={newPwd}
                  autoComplete="new-password"
                  onChange={(e) => setNewPwd(e.target.value)}
                />
              </Field>
              <Field label="确认新主口令" required>
                <input
                  type="password"
                  value={newPwd2}
                  autoComplete="new-password"
                  onChange={(e) => setNewPwd2(e.target.value)}
                />
              </Field>
              <Toggle
                checked={autoUnlock}
                onChange={setAutoUnlock}
                label="开启自动解锁"
                hint="使用 Windows 凭据管理（DPAPI）保存解锁凭据。"
              />
              <div className="set-actions">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void submitPassword()}>
                  保存新主口令
                </Button>
                <div className="grow" />
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void lockNow()}>
                  <Icon.Key size={13} /> 立即锁定
                </Button>
              </div>
            </div>
            <div className="set-hint">锁定后需要重新输入主口令才能读写数据。</div>
          </section>

          <section className="set-section set-section-gap">
            <div className="detail-label">隐私与开源</div>
            <div className="notice notice-info">
              <span className="notice-icon">
                <Icon.Info size={15} />
              </span>
              <span>
                <strong>所有数据仅在本机处理</strong>，不会上传任何聊天记录、账号信息或 API Key。
                调用大模型时，只把你<strong>选定会话</strong>的聊天片段发送到<strong>你自己配置</strong>的
                LLM 平台，数据去向由该平台决定，请阅读其隐私政策。本软件不收集任何遥测数据。
              </span>
            </div>
            <div className="section-card set-kv">
              <div className="kv">
                <span className="kv-key">许可证</span>
                <div className="kv-val">MIT License（开源）</div>
              </div>
              <div className="kv">
                <span className="kv-key">第三方依赖</span>
                <div className="kv-val">
                  wechat_exp、QQFlow —— 不随本软件分发，遵循各自许可证
                </div>
              </div>
            </div>
            <div className="set-actions">
              <Button
                size="sm"
                onClick={() =>
                  void tryCall(
                    () => api.openExternal('https://github.com/MoonCat-640/WX_msg_grb'),
                    '打开项目主页失败'
                  )
                }
              >
                <Icon.Link size={14} /> 打开项目主页
              </Button>
            </div>
            <div className="set-hint">
              密钥提取依赖第三方工具（wechat_exp / QQFlow），它们会访问本机微信/QQ 数据，
              请自行评估其安全性。
            </div>
          </section>
        </>
      )}
    </Modal>
  )
}
