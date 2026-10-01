/**
 * 右上角账户按钮（需求 UI 设计 第 4 点）
 * ------------------------------------------------------------------
 * 需求原文：
 *   「右上角为账户，平时为显示"My Account"字样的按钮，颜色比主题色略浅，
 *     鼠标移动到该按钮上后，渐显一个小框，显示已登录的平台和其账户数量，
 *     单击按钮后进入账户管理界面。」
 *
 * 交互细节：
 *   - 悬停不是「立刻」出框，而是延迟 120ms —— 鼠标只是划过顶栏时不应该闪烁。
 *   - 离开同样延迟收起：浮框与按钮之间有 8px 间隙（见 layout.css 的
 *     `top: calc(100% + 8px)`），鼠标从按钮移向浮框的途中会经过这个空隙；
 *     若不延迟收起，浮框会在到达之前就消失，用户根本点不到。
 *   - 浮框是按钮所在 `.account-wrap` 的子节点，所以只要指针还在浮框上，
 *     父级的 mouseleave 就不会触发，这也是「移到浮框上保持显示」的实现方式。
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import type { AccountButtonProps } from './contracts'
import { Icon } from './icons'

export function AccountButton({ accounts, platforms, onClick }: AccountButtonProps): JSX.Element {
  const [open, setOpen] = useState(false)
  // 用同一个 timer 同时承担「延迟显示」和「延迟收起」，天然互斥
  const timer = useRef<number | null>(null)

  const clearTimer = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  const schedule = (next: boolean): void => {
    clearTimer()
    timer.current = window.setTimeout(() => setOpen(next), 120)
  }

  // 组件卸载必须清掉定时器，否则会对已卸载组件调用 setState
  useEffect(() => clearTimer, [])

  const total = accounts.length

  return (
    <div
      className="account-wrap"
      onMouseEnter={() => schedule(true)}
      onMouseLeave={() => schedule(false)}
    >
      <button type="button" className="account-btn" title="账户管理" onClick={onClick}>
        <Icon.User size={15} />
        <span>My Account</span>
        {/* 总数角标只在有账号时出现，避免空状态下也挂一个「0」 */}
        {total > 0 && <span className="account-count">{total}</span>}
      </button>

      {open && (
        <div className="account-popover" role="tooltip">
          <div className="account-popover-title">已登录账号</div>
          {platforms.map((p) => {
            const n = accounts.filter((a) => a.platform === p.id).length
            return (
              <div className="account-popover-row" key={p.id}>
                <span className="account-popover-dot" style={{ background: p.color }} />
                <span className="grow">{p.label}</span>
                {/* 0 个账号用灰色弱化，一眼能区分「该平台没登录」和「登录了几个」 */}
                <span className={n === 0 ? 'text-tertiary' : 'text-secondary'}>{n} 个账号</span>
              </div>
            )
          })}
          <div className="account-popover-hint">
            {total === 0 ? '尚未登录任何账号，点击添加' : '点击进入账户管理'}
          </div>
        </div>
      )}
    </div>
  )
}
