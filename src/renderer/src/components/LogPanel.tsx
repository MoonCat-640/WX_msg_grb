/**
 * 日志面板（调试用）
 * ------------------------------------------------------------------
 * 数据来自 api.readLogs(limit, level) + 主进程推送的 'log' 事件。
 *
 * 关键约束：
 *  - 订阅必须在 cleanup 里退订，否则反复开关面板会累积多份监听，日志会重复。
 *  - 内存里最多保留 2000 条，超出丢弃最旧的，避免长时间开着把内存吃满。
 *  - 自动滚动开启时，新日志到达后把列表滚到底部。
 */
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { LogEntry, LogLevel } from '@shared/types'
import { utc8Parts } from '@shared/time'
import { api, on, toast, toastError, tryCall } from '../api'
import type { LogPanelProps } from './contracts'
import { Button, EmptyState, Modal, Spinner, Tabs, Toggle } from './primitives'
import type { TabItem } from './primitives'
import { Icon } from './icons'

/** 内存中最多保留的日志条数 */
const MAX_LOGS = 2000

type LevelFilter = 'all' | LogLevel

const LEVEL_ITEMS: TabItem<LevelFilter>[] = [
  { key: 'all', label: '全部' },
  { key: 'debug', label: 'debug' },
  { key: 'info', label: 'info' },
  { key: 'warn', label: 'warn' },
  { key: 'error', label: 'error' }
]

/** 日志行的时间戳：HH:MM:SS（UTC+8 口径，与全局时间口径一致） */
function fmtLogTime(ts: number): string {
  const p = utc8Parts(ts)
  const z = (n: number): string => String(n).padStart(2, '0')
  return `${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}:${z(p.second)}`
}

/** detail 可能是任意结构，尽力序列化成可读文本 */
function formatDetail(detail: unknown): string {
  if (detail === undefined) return ''
  if (detail === null) return 'null'
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail, null, 2)
  } catch {
    return String(detail)
  }
}

export function LogPanel({ open, onClose }: LogPanelProps): JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [level, setLevel] = useState<LevelFilter>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [logDir, setLogDir] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 拉取历史日志：切级别 / 重新打开时重新拉
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    api
      .readLogs(MAX_LOGS, level === 'all' ? undefined : level)
      .then((list) => {
        if (cancelled) return
        setLogs(list.length > MAX_LOGS ? list.slice(list.length - MAX_LOGS) : list)
      })
      .catch((e) => {
        if (!cancelled) toastError(e, '读取日志失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, level])

  // 订阅实时日志；cleanup 必须退订
  useEffect(() => {
    if (!open) return
    const off = on('log', (entry) => {
      if (level !== 'all' && entry.level !== level) return
      setLogs((prev) => {
        const next = prev.length >= MAX_LOGS ? prev.slice(prev.length - MAX_LOGS + 1) : prev
        return [...next, entry]
      })
    })
    return () => off()
  }, [open, level])

  // 日志目录（用于「打开日志文件目录」）
  useEffect(() => {
    if (!open || logDir) return
    let cancelled = false
    api
      .appInfo()
      .then((v) => {
        if (!cancelled) setLogDir(v.logDir)
      })
      .catch(() => {
        /* 拿不到就不显示该按钮的可用路径，打开时会提示 */
      })
    return () => {
      cancelled = true
    }
  }, [open, logDir])

  // 自动滚动到底部
  useEffect(() => {
    if (!autoScroll) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, autoScroll])

  const toggleExpand = (ts: number): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(ts)) next.delete(ts)
      else next.add(ts)
      return next
    })

  const clearLogs = async (): Promise<void> => {
    const ok = await tryCall(
      async () => {
        await api.clearLogs()
        return true
      },
      '清空日志失败'
    )
    if (ok) {
      setLogs([])
      toast('ok', '已清空日志')
    }
  }

  const openLogDir = async (): Promise<void> => {
    if (!logDir) {
      toast('warn', '尚未取到日志目录，请稍后重试')
      return
    }
    await tryCall(() => api.openPath(logDir), '打开日志目录失败')
  }

  const toolbar = (
    <div className="logp-toolbar">
      <Tabs variant="pill" items={LEVEL_ITEMS} active={level} onChange={setLevel} />
      <div className="logp-spacer" />
      <Toggle checked={autoScroll} onChange={setAutoScroll} label="自动滚动" />
      <Button size="sm" onClick={() => void clearLogs()}>
        <Icon.Trash size={13} /> 清空
      </Button>
      <Button size="sm" onClick={() => void openLogDir()}>
        <Icon.Folder size={13} /> 打开日志文件目录
      </Button>
    </div>
  )

  return (
    <Modal open={open} width={900} title="日志" subtitle={`最多保留最近 ${MAX_LOGS} 条`} onClose={onClose}>
      {toolbar}

      {loading && logs.length === 0 ? (
        <div className="logp-loading">
          <Spinner size={18} /> 正在读取日志…
        </div>
      ) : logs.length === 0 ? (
        <EmptyState icon={Icon.Log} title="暂无日志" description="运行过程中产生的日志会实时显示在这里。" />
      ) : (
        <div className="logp-list" ref={listRef}>
          {logs.map((e, i) => {
            const hasDetail = e.detail !== undefined
            const isOpen = expanded.has(e.ts)
            return (
              <div className="logp-entry" key={`${e.ts}-${i}`}>
                <div
                  className={['logp-row', `logp-lv-${e.level}`].join(' ')}
                  onClick={() => hasDetail && toggleExpand(e.ts)}
                >
                  <span className="logp-ts">{fmtLogTime(e.ts)}</span>
                  <span className="logp-level">{e.level}</span>
                  <span className="logp-scope">[{e.scope}]</span>
                  <span className="logp-msg">{e.message}</span>
                  {hasDetail && (
                    <span className="logp-expand">
                      <Icon.ChevronDown size={12} className={isOpen ? 'is-open' : undefined} />
                    </span>
                  )}
                </div>
                {hasDetail && isOpen && <div className="logp-detail">{formatDetail(e.detail)}</div>}
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
