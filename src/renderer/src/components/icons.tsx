/**
 * 图标集
 * ------------------------------------------------------------------
 * 全部用内联 SVG（stroke 描边、currentColor 取色），不引第三方图标库：
 *   - 不增加依赖与包体积
 *   - 颜色跟随文字色，主题切换时自动适配
 * 统一 24×24 viewBox，通过 size 属性缩放。
 */
import type { JSX } from 'react'

export interface IconProps {
  size?: number
  className?: string
  /** 线宽，默认 1.8（暗色界面下 1.6~2.0 最清晰） */
  strokeWidth?: number
}

function Svg({
  size = 18,
  className,
  strokeWidth = 1.8,
  children
}: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const Icon = {
  /** 聊天/消息 */
  Chat: (p: IconProps) => (
    <Svg {...p}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
    </Svg>
  ),
  /** 磁贴/看板 */
  Grid: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
    </Svg>
  ),
  /** 进行中（时钟） */
  Clock: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 1.9" />
    </Svg>
  ),
  /** 未开始（日历） */
  Calendar: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="5" width="18" height="16" rx="2.2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Svg>
  ),
  /** 已完成（对勾圈） */
  CheckCircle: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.2 12.4l2.6 2.6 5-5.2" />
    </Svg>
  ),
  /** 已过期（沙漏/警示） */
  Expired: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.2" />
      <circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Check: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4.5 12.5l5 5 10-11" />
    </Svg>
  ),
  Trash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13" />
      <path d="M10.5 10v6M13.5 10v6" />
    </Svg>
  ),
  Close: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),
  Plus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  Minus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 12h14" />
    </Svg>
  ),
  Refresh: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20.5 11.5a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4.5v5h-5" />
    </Svg>
  ),
  Search: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5L21 21" />
    </Svg>
  ),
  Settings: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.5 1z" />
    </Svg>
  ),
  /** 用户 */
  User: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </Svg>
  ),
  Users: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" />
      <path d="M16.2 5.2a3.4 3.4 0 0 1 0 6.6M17.5 14.4a6.2 6.2 0 0 1 3.7 5.6" />
    </Svg>
  ),
  Key: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16 3.5L20 7.5M14 5.5L17.5 9" />
    </Svg>
  ),
  Link: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1.5 1.5" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1.5-1.5" />
    </Svg>
  ),
  File: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 3h7l5 5v13H6z" />
      <path d="M13 3v5h5" />
    </Svg>
  ),
  Doc: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </Svg>
  ),
  Form: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h4" />
    </Svg>
  ),
  Log: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 4h14v16H5z" />
      <path d="M8.5 9h7M8.5 13h7M8.5 17h4" />
    </Svg>
  ),
  ChevronRight: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />
    </Svg>
  ),
  ChevronLeft: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </Svg>
  ),
  ChevronDown: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5.5 9.5L12 16l6.5-6.5" />
    </Svg>
  ),
  Warn: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3.6L21 19.5H3z" />
      <path d="M12 9.5v4.2" />
      <circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Info: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Robot: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="7.5" width="16" height="11.5" rx="2.4" />
      <path d="M12 4.5v3M9.5 12.2v1.6M14.5 12.2v1.6M2.5 11.5v4M21.5 11.5v4" />
    </Svg>
  ),
  Sync: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5" />
      <path d="M20 4.5v4h-4M4 19.5v-4h4" />
    </Svg>
  ),
  Stop: (p: IconProps) => (
    <Svg {...p}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    </Svg>
  ),
  Edit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M15.5 4.5l4 4L8 20H4v-4z" />
      <path d="M13.5 6.5l4 4" />
    </Svg>
  ),
  Copy: (p: IconProps) => (
    <Svg {...p}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
      <path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </Svg>
  ),
  Folder: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.5 6.5a2 2 0 0 1 2-2h3.2l1.8 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Svg>
  ),
  Play: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7.5 4.8l12 7.2-12 7.2z" />
    </Svg>
  ),
  Eye: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  EyeOff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10.6 6a8.6 8.6 0 0 1 1.4-.1c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2M6.4 7.7A17 17 0 0 0 2.5 12.4S6 18.9 12 18.9a8.9 8.9 0 0 0 3.6-.7" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
    </Svg>
  ),
  Filter: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.5 5.5h17l-6.6 8v6l-3.8-2v-4z" />
    </Svg>
  ),
  Sparkles: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7z" />
      <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </Svg>
  )
}

export type IconName = keyof typeof Icon

/**
 * 状态 → 图标 的映射（左侧类别栏与磁贴共用，保持唯一来源）
 * 注意：这里不引 shared 的类型，避免渲染层与主进程类型耦合过深；
 * 传进来的字符串若不在表内，调用方应自行兜底。
 */
export function statusIcon(status: string): (p: IconProps) => JSX.Element {
  switch (status) {
    case 'ongoing':
      return Icon.Clock
    case 'upcoming':
      return Icon.Calendar
    case 'done':
      return Icon.CheckCircle
    case 'expired':
      return Icon.Expired
    case 'deleted':
      // 「已删除」是回收站语义（更新需求 §4），用垃圾桶图标最直观
      return Icon.Trash
    default:
      return Icon.Grid
  }
}
