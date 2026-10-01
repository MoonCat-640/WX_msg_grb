/**
 * 保险库解锁页
 * ------------------------------------------------------------------
 * 只在「自动解锁失败」时出现（例如换了 Windows 用户、首次运行后手动锁定、
 * 或者用户在设置里关闭了自动解锁）。
 *
 * 为什么保留这个页面而不是强制自动解锁：
 *   需求要求「所有敏感的且需要储存的信息，都应该进行加密以防止被破解」。
 *   自动解锁（口令交给 Windows DPAPI 保管）是便利与安全的折中，
 *   但必须给用户一个「只用口令、不留后门」的选择。
 */
import { useState, type JSX } from 'react'
import type { VaultStatus } from '@shared/types'
import { api, toast } from '../api'
import { Button, Field } from './primitives'
import { Icon } from './icons'

export interface UnlockScreenProps {
  status: VaultStatus
  /** 解锁成功后通知外壳重新初始化 */
  onUnlocked: (next: VaultStatus) => void
}

export function UnlockScreen({ status, onUnlocked }: UnlockScreenProps): JSX.Element {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = async (): Promise<void> => {
    if (!password) {
      setError('请输入主口令')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const next = await api.vaultUnlock(password)
      setPassword('')
      toast('ok', '已解锁，正在载入数据…')
      onUnlocked(next)
    } catch (e) {
      // 口令错误是高频操作，错误就地显示在输入框下方，比弹 toast 更顺手
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lock-screen">
      <div className="lock-card anim-rise">
        <div className="lock-icon">
          <Icon.Key size={24} />
        </div>
        <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 600, marginBottom: 8 }}>
          解锁数据保险库
        </div>
        <div
          className="text-sm text-secondary"
          style={{ lineHeight: 1.75, marginBottom: 22 }}
        >
          账号信息、AI 平台 Key 与聊天记录都经过加密存储。
          <br />
          请输入主口令以继续。
        </div>

        <Field label="主口令" error={error} required>
          <input
            type="password"
            autoFocus
            value={password}
            placeholder="请输入主口令"
            onChange={(e) => {
              setPassword(e.target.value)
              if (error) setError(undefined)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </Field>

        <Button variant="primary" block loading={busy} onClick={() => void submit()}>
          解锁
        </Button>

        <div className="text-xs text-tertiary" style={{ marginTop: 20, lineHeight: 1.8 }}>
          {status.kdf.algorithm} · 迭代 {status.kdf.iterations.toLocaleString('zh-CN')} 次 ·{' '}
          {status.kdf.cipher}
          <br />
          {status.autoUnlock
            ? '已开启自动解锁，但本次未能自动读取凭据（可能更换了 Windows 用户）。'
            : '未开启自动解锁，每次启动都需要输入主口令。'}
        </div>

        <div className="text-xs text-tertiary" style={{ marginTop: 16, lineHeight: 1.8 }}>
          如果忘记了主口令，数据无法解密（这是加密的正常结果，没有后门）。
          可在「设置 → 安全」里改用记得住的口令；数据目录位置见设置页的「界面」页签。
        </div>
      </div>
    </div>
  )
}
