/**
 * 登录 / 账号添加向导
 * ------------------------------------------------------------------
 * 更新需求 §1 明确了边界，这一版据此彻底重做：
 *
 *   ✗ 取消所有平台的**扫码登录**——微信/QQ/企业微信的扫码协议都是私有协议，
 *     拿不到也不该去逆向，界面上不再有占位二维码。
 *   ✗ 取消**企业微信**——企业办公软件的权限与加密更复杂，暂不接入。
 *   ✓ 只保留两个平台：**微信**与 **QQ**。
 *   ✓ 账号数量**不再设上限**（更新需求：多开由用户自理）。
 *
 * 两个平台各自可用的登记方式（这是真正能拿到数据的两条路）：
 *   微信 —— 「检测本机已登录账号」：调 wechat_exp 扫本机 db_storage 目录识别账号。
 *    QQ  —— 「手动添加账号」：填 QQ 号 + 选 nt_msg.db + 填数据库密钥。
 *           密钥可以从 QQFlow 已提取的密钥文件里导入（我们不去注入 QQ 进程）。
 */
import { useCallback, useEffect, useState, type JSX } from 'react'
import type { Account, PlatformDescriptor, PlatformId, QqDatabase } from '@shared/types'
import { api, toast, toastError, tryCall } from '../api'
import { Button, Field, Spinner } from './primitives'
import { Icon } from './icons'
import type { LoginWizardProps } from './contracts'

/** 平台卡片上的一句话说明（如实告知这个平台怎么接入） */
const PLATFORM_HINT: Record<PlatformId, string> = {
  wechat: '通过 wechat_exp 读取本机已登录的微信数据目录，无需扫码。',
  qq: '填写 QQ 号与数据库密钥；密钥可复用 QQFlow 已提取的结果。'
}

export function LoginWizard({
  open,
  onClose,
  onAccountsChanged,
  onFinish,
  onCancel,
  firstRun
}: LoginWizardProps): JSX.Element | null {
  const [platforms, setPlatforms] = useState<PlatformDescriptor[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [active, setActive] = useState<PlatformId | null>(null)
  const [busy, setBusy] = useState(false)

  /* 微信：本机识别 */
  const [detectMsg, setDetectMsg] = useState<string | null>(null)

  /* QQ：手动添加 */
  const [dbs, setDbs] = useState<QqDatabase[]>([])
  const [qqNumber, setQqNumber] = useState('')
  const [dbPath, setDbPath] = useState('')
  const [qqKey, setQqKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<string | null>(null)

  /** 拉取平台清单与已有账号 */
  const refresh = useCallback(async () => {
    const [ps, as] = await Promise.all([api.platforms(), api.accounts()])
    setPlatforms(ps)
    setAccounts(as)
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const [ps, as] = await Promise.all([api.platforms(), api.accounts()])
        if (cancelled) return
        setPlatforms(ps)
        setAccounts(as)
        // 默认落在第一个平台，少一次点击
        setActive((cur) => cur ?? ps[0]?.id ?? null)
      } catch (e) {
        if (!cancelled) toastError(e, '加载平台信息失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const countOf = (p: PlatformId): number => accounts.filter((a) => a.platform === p).length

  /* ---------------- 微信：检测本机账号 ---------------- */
  const handleDetectWechat = async (): Promise<void> => {
    setBusy(true)
    setDetectMsg(null)
    try {
      const list = await api.accountDetectLocal('wechat')
      const mine = list.filter((a) => a.platform === 'wechat')
      setDetectMsg(
        mine.length > 0
          ? `已识别到 ${mine.length} 个本机微信账号`
          : '未找到本机微信账号，请确认微信已登录、且数据目录不在非常规位置'
      )
      setAccounts(list)
      onAccountsChanged()
      if (mine.length > 0) toast('ok', `已识别到 ${mine.length} 个本机微信账号`)
    } catch (e) {
      setDetectMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- QQ：扫描数据库 ---------------- */
  const handleScanQq = async (): Promise<void> => {
    setBusy(true)
    try {
      const list = await api.qqScanDatabases()
      setDbs(list)
      if (list.length === 0) {
        toast('warn', '未找到本机 QQ 数据库（通常位于「文档\\Tencent Files\\<QQ号>\\nt_qq\\nt_db」）')
      } else {
        toast('ok', `找到 ${list.length} 个 QQ 数据库`)
        // 默认选最大的那个（通常就是主账号）
        const biggest = [...list].sort((a, b) => b.sizeMb - a.sizeMb)[0]
        if (biggest) {
          setQqNumber((v) => v || biggest.qq)
          setDbPath((v) => v || biggest.path)
        }
      }
    } catch (e) {
      toastError(e, '扫描 QQ 数据库失败')
    } finally {
      setBusy(false)
    }
  }

  /** 查询密钥状态：本软件里有没有 / 能不能从 QQFlow 复用 */
  const handleCheckKey = async (qq: string): Promise<void> => {
    if (!qq.trim()) return
    const st = await tryCall(() => api.qqKeyStatus(qq.trim()), '查询密钥状态失败')
    if (st) setKeyStatus(st.message)
  }

  /** 从 QQFlow 的密钥文件导入（我们只读它的文件，不启动它的程序） */
  const handleImportFromQqflow = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.qqImportFromQqflow(qqNumber.trim())
      toast(r.ok ? 'ok' : 'warn', r.message)
      if (r.ok) await handleCheckKey(qqNumber)
    } catch (e) {
      toastError(e, '导入 QQFlow 密钥失败')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 打开 QQFlow（第二次更新需求 §2/§5）。
   * QQFlow 是纯 GUI 程序、没有命令行参数，所以本软件只能"启动它"；
   * 用户在其窗口里提取密钥后，密钥会写到 %APPDATA%\qqflow\qqflow_keys.json，
   * 再点「从 QQFlow 导入」即可。
   */
  const handleOpenQqflow = async (): Promise<void> => {
    const r = await tryCall(() => api.qqLaunchQqflow(), '启动 QQFlow 失败')
    if (!r) return
    toast(r.launched ? 'ok' : 'warn', r.message)
  }

  /** 保存密钥到本应用（加密存储），方便下回不用再填 */
  const handleSaveKey = async (): Promise<void> => {
    if (!qqNumber.trim() || !qqKey.trim()) {
      toast('warn', '请先填写 QQ 号与密钥')
      return
    }
    setBusy(true)
    try {
      const r = await api.qqSaveKey(qqNumber.trim(), qqKey.trim())
      toast(r.ok ? 'ok' : 'error', r.message)
      if (r.ok) {
        setQqKey('')
        await handleCheckKey(qqNumber)
      }
    } catch (e) {
      toastError(e, '保存密钥失败')
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- QQ：添加账号 ---------------- */
  const handleAddQqAccount = async (): Promise<void> => {
    if (!qqNumber.trim()) {
      toast('warn', '请填写 QQ 号')
      return
    }
    setBusy(true)
    try {
      const acc = await api.accountAddManual({
        platform: 'qq',
        platformAccountId: qqNumber.trim(),
        displayName: `QQ ${qqNumber.trim()}`,
        dbPath: dbPath.trim() || undefined,
        key: qqKey.trim() || undefined
      })
      toast('ok', `已添加账号：${acc.displayName}`)
      setAccounts(await api.accounts())
      onAccountsChanged()
    } catch (e) {
      toastError(e, '添加 QQ 账号失败')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const total = accounts.length

  return (
    <div className="scrim">
      <div className="modal" style={{ width: 780 }} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="col grow">
            <div className="modal-title">{firstRun ? '首次配置 · 添加账号' : '添加账号'}</div>
            <div className="modal-subtitle">
              微信与 QQ 的数据都存在本机，本软件直接读取本地数据目录，
              <strong>不需要扫码登录</strong>。
            </div>
          </div>
        </header>

        <div className="modal-body">
          {/* 平台选择 */}
          <div className="wizard-platforms">
            {platforms.map((p) => (
              <button
                key={p.id}
                type="button"
                className={['wizard-platform', active === p.id ? 'is-active' : ''].join(' ')}
                style={{ ['--platform-color' as string]: p.color }}
                onClick={() => setActive(p.id)}
              >
                <span className="wizard-platform-dot" style={{ background: p.color }} />
                <span className="wizard-platform-name">{p.label}</span>
                <span className="wizard-platform-count">已添加 {countOf(p.id)} 个</span>
                <span className="wizard-platform-hint">{PLATFORM_HINT[p.id]}</span>
              </button>
            ))}
          </div>

          {!active ? (
            <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
              <Spinner size={18} />
            </div>
          ) : active === 'wechat' ? (
            /* ---------------- 微信 ---------------- */
            <div className="wizard-panel">
              <div className="notice notice-info">
                <span className="notice-icon">
                  <Icon.Info size={15} />
                </span>
                <span>
                  微信的聊天记录由本机数据目录读取，因此
                  <strong>无需真实的扫码登录</strong>。
                  点下面的按钮，本软件会调用 wechat_exp 扫描本机已登录的微信账号。
                </span>
              </div>

              <div className="row gap-md" style={{ marginTop: 16 }}>
                <Button variant="primary" loading={busy} onClick={() => void handleDetectWechat()}>
                  <Icon.Search size={14} />
                  检测本机已登录账号
                </Button>
                <span className="text-sm text-tertiary">
                  需要微信正在运行并已登录
                </span>
              </div>

              {detectMsg && (
                <div className="notice" style={{ marginTop: 14 }}>
                  {detectMsg}
                </div>
              )}

              {countOf('wechat') > 0 && (
                <div className="wizard-added">
                  <div className="wizard-added-title">已添加的微信账号</div>
                  {accounts
                    .filter((a) => a.platform === 'wechat')
                    .map((a) => (
                      <div key={a.id} className="wizard-added-row">
                        <Icon.User size={13} />
                        <span className="grow ellipsis">{a.displayName}</span>
                        <span className="text-xs text-tertiary mono ellipsis" style={{ maxWidth: 240 }}>
                          {a.dbStorageDir ?? '—'}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          ) : (
            /* ---------------- QQ ---------------- */
            <div className="wizard-panel">
              <div className="notice notice-warn">
                <span className="notice-icon">
                  <Icon.Warn size={15} />
                </span>
                <span>
                  QQ 的聊天数据库是加密的，需要 16 位密钥。本软件
                  <strong>不注入 QQ 进程</strong>（那需要调试 API），
                  改为：优先复用你已经用 QQFlow 提取过的密钥，或由你手动粘贴。
                  密钥会加密保存在本机。
                </span>
              </div>

              <div className="row gap-sm" style={{ marginTop: 14 }}>
                <Button variant="subtle" loading={busy} onClick={() => void handleScanQq()}>
                  <Icon.Search size={14} />
                  扫描本机 QQ 数据库
                </Button>
                <span className="text-sm text-tertiary">
                  位于「文档\Tencent Files\&lt;QQ号&gt;\nt_qq\nt_db\nt_msg.db」
                </span>
              </div>

              {dbs.length > 0 && (
                <div className="wizard-db-list">
                  {dbs.map((d) => (
                    <button
                      key={d.path}
                      type="button"
                      className={['wizard-db', dbPath === d.path ? 'is-active' : ''].join(' ')}
                      onClick={() => {
                        setDbPath(d.path)
                        setQqNumber(d.qq)
                        void handleCheckKey(d.qq)
                      }}
                    >
                      <span className="mono">QQ {d.qq}</span>
                      <span className="text-xs text-tertiary">{d.sizeMb.toFixed(1)} MB</span>
                    </button>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <Field label="QQ 号" required>
                  <input
                    value={qqNumber}
                    placeholder="例如 123456789"
                    onChange={(e) => setQqNumber(e.target.value)}
                    onBlur={() => void handleCheckKey(qqNumber)}
                  />
                </Field>

                {keyStatus && (
                  <div className="text-xs text-tertiary" style={{ marginTop: -8, marginBottom: 12 }}>
                    密钥状态：{keyStatus}
                  </div>
                )}

                <Field
                  label="数据库密钥"
                  hint="16 位字符。若你已用 QQFlow 提取过，点右边的「从 QQFlow 导入」即可，无需手输。"
                >
                  <div className="row gap-sm">
                    <input
                      className="grow"
                      value={qqKey}
                      placeholder="16 位密钥"
                      onChange={(e) => setQqKey(e.target.value)}
                    />
                    <Button variant="subtle" onClick={() => void handleSaveKey()} disabled={busy}>
                      保存密钥
                    </Button>
                    <Button variant="ghost" onClick={() => void handleImportFromQqflow()} disabled={busy}>
                      <Icon.Sync size={13} />
                      从 QQFlow 导入
                    </Button>
                    <Button variant="ghost" onClick={() => void handleOpenQqflow()} disabled={busy}>
                      <Icon.Play size={13} />
                      打开 QQFlow
                    </Button>
                  </div>
                </Field>

                <div className="row gap-sm" style={{ marginTop: 12 }}>
                  <Button variant="primary" loading={busy} onClick={() => void handleAddQqAccount()}>
                    <Icon.Plus size={14} />
                    添加该 QQ 账号
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={total === 0}
            title={total === 0 ? '至少添加一个账号后才能继续' : undefined}
            onClick={() => {
              onAccountsChanged()
              onFinish()
            }}
          >
            完成（已添加 {total} 个账号）
          </Button>
        </footer>
      </div>
    </div>
  )
}
