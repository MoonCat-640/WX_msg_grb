/**
 * 基础 UI 组件
 * ------------------------------------------------------------------
 * 只做「无业务含义」的通用控件：按钮、弹窗、抽屉、表单行、标签…
 * 业务组件（磁贴、任务详情、登录向导…）都建立在这些之上。
 *
 * 关键交互约定：
 *   - 弹窗支持 ESC 关闭；点击遮罩是否关闭由 closeOnScrim 控制
 *     （登录向导、Key 输入这类「不能误关」的场景要关掉它）
 *   - 所有可点击元素都有 :focus-visible 焦点环，键盘可用
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Icon } from './icons'

/* ------------------------------------------------------------------ */
/* 按钮                                                                */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'ghost' | 'subtle' | 'danger' | 'ok' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps {
  children?: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  disabled?: boolean
  loading?: boolean
  title?: string
  className?: string
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  /** 铺满父容器宽度 */
  block?: boolean
}

export function Button({
  children,
  variant = 'subtle',
  size = 'md',
  disabled,
  loading,
  title,
  className,
  onClick,
  block
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={[
        'btn',
        `btn-${variant}`,
        `btn-${size}`,
        block ? 'btn-block' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      title={title}
      onClick={onClick}
    >
      {loading && <Spinner size={13} />}
      {children}
    </button>
  )
}

export interface IconButtonProps {
  icon: (p: { size?: number }) => JSX.Element
  title: string
  size?: number
  disabled?: boolean
  className?: string
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
}

export function IconButton({
  icon: IconCmp,
  title,
  size = 16,
  disabled,
  className,
  onClick
}: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={['icon-btn', className ?? ''].filter(Boolean).join(' ')}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      <IconCmp size={size} />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 表单                                                                */
/* ------------------------------------------------------------------ */

export interface FieldProps {
  label: string
  hint?: ReactNode
  error?: string
  required?: boolean
  children: ReactNode
}

export function Field({ label, hint, error, required, children }: FieldProps): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && <span className="field-required">*</span>}
      </span>
      {children}
      {error ? (
        <span className="field-error">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  )
}

export interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: ReactNode
  disabled?: boolean
  hint?: ReactNode
}

export function Toggle({ checked, onChange, label, disabled, hint }: ToggleProps): JSX.Element {
  return (
    <div className={['toggle-row', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={['toggle', checked ? 'is-on' : ''].filter(Boolean).join(' ')}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-knob" />
      </button>
      {(label || hint) && (
        <span className="toggle-text">
          {label && <span className="toggle-label">{label}</span>}
          {hint && <span className="field-hint">{hint}</span>}
        </span>
      )}
    </div>
  )
}

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange: (next: T) => void
  disabled?: boolean
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled
}: SelectProps<T>): JSX.Element {
  return (
    <select
      className="select"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/* ------------------------------------------------------------------ */
/* 反馈                                                                */
/* ------------------------------------------------------------------ */

export function Spinner({ size = 16 }: { size?: number }): JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="加载中" />
}

export interface EmptyStateProps {
  icon?: (p: { size?: number }) => JSX.Element
  title: string
  description?: ReactNode
  action?: ReactNode
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps): JSX.Element {
  const IconCmp = icon
  return (
    <div className="empty-state">
      {IconCmp && (
        <div className="empty-icon">
          <IconCmp size={34} />
        </div>
      )}
      <div className="empty-title">{title}</div>
      {description && <div className="empty-desc">{description}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export interface StatusChipProps {
  /** 状态色，传 CSS 颜色值 */
  color: string
  children: ReactNode
  /** 尺寸 */
  size?: 'sm' | 'md'
  /** 是否描边样式（更轻） */
  outline?: boolean
}

export function StatusChip({ color, children, size = 'sm', outline }: StatusChipProps): JSX.Element {
  const style = outline
    ? { color, borderColor: color, background: 'transparent' }
    : { color, background: `color-mix(in srgb, ${color} 16%, transparent)` }
  return (
    <span className={['chip', `chip-${size}`, outline ? 'chip-outline' : ''].join(' ')} style={style}>
      {children}
    </span>
  )
}

export function ProgressBar({
  value,
  color,
  height = 4
}: {
  /** 0~1 */
  value: number
  color?: string
  height?: number
}): JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="progress" style={{ height }}>
      <div
        className="progress-fill"
        style={{ width: `${pct}%`, background: color ?? 'var(--accent)' }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 标签页                                                              */
/* ------------------------------------------------------------------ */

export interface TabItem<T extends string> {
  key: T
  label: ReactNode
  /** 右侧角标数字 */
  badge?: number
  disabled?: boolean
  /** 前置色点（用于账号标签页区分平台） */
  color?: string
}

export function Tabs<T extends string>({
  items,
  active,
  onChange,
  variant = 'underline'
}: {
  items: TabItem<T>[]
  active: T
  onChange: (key: T) => void
  variant?: 'underline' | 'pill'
}): JSX.Element {
  return (
    <div className={['tabs', `tabs-${variant}`].join(' ')} role="tablist">
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          aria-selected={it.key === active}
          disabled={it.disabled}
          className={['tab', it.key === active ? 'is-active' : ''].join(' ')}
          onClick={() => onChange(it.key)}
        >
          {it.color && <span className="tab-dot" style={{ background: it.color }} />}
          <span className="tab-label">{it.label}</span>
          {it.badge !== undefined && it.badge > 0 && <span className="tab-badge">{it.badge}</span>}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 弹窗 / 抽屉                                                         */
/* ------------------------------------------------------------------ */

export interface ModalProps {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** 面板宽度，默认 560 */
  width?: number
  /** 点遮罩是否关闭，默认 true；向导类请设 false 防误关 */
  closeOnScrim?: boolean
  /** 是否显示右上角关闭按钮 */
  showClose?: boolean
  className?: string
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
  closeOnScrim = true,
  showClose = true,
  className
}: ModalProps): JSX.Element | null {
  // ESC 关闭：注意只在打开时挂监听，关闭后必须摘掉，否则会误关别的弹窗
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        // 只在按下就发生在遮罩本身时才关闭，避免从面板内拖到遮罩上误关
        if (closeOnScrim && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={['modal', 'anim-pop', className ?? ''].filter(Boolean).join(' ')}
        style={{ width }}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <div className="col grow">
            <div className="modal-title">{title}</div>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          {showClose && <IconButton icon={Icon.Close} title="关闭" onClick={onClose} />}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export interface DrawerProps {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** 抽屉宽度，默认 620 */
  width?: number
}

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 620
}: DrawerProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="scrim scrim-drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer anim-slide-right"
        style={{ width }}
        role="dialog"
        aria-modal="true"
      >
        <header className="drawer-head">
          <div className="col grow">
            <div className="drawer-title">{title}</div>
            {subtitle && <div className="drawer-subtitle">{subtitle}</div>}
          </div>
          <IconButton icon={Icon.Close} title="关闭" onClick={onClose} />
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 小工具：可复制的文本                                                */
/* ------------------------------------------------------------------ */

export function CopyableText({ text, label }: { text: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  return (
    <button
      type="button"
      className="copyable"
      title={label ?? '点击复制'}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      <span className="mono ellipsis">{text}</span>
      <span className="copyable-icon">{copied ? <Icon.Check size={13} /> : <Icon.Copy size={13} />}</span>
    </button>
  )
}
