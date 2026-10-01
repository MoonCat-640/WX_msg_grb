/**
 * wechat_exp HTTP 客户端
 * ------------------------------------------------------------------
 * 用全局 fetch + AbortController 做超时，不引入任何第三方依赖。
 *
 * 两个容易踩的点（契约文档 §B.4 / §F.4）：
 *   1. **超时**：默认超时来自设置里的 ioTimeoutMs。为避免 client 依赖 electron，
 *      这里用一个模块级默认值，由 service 启动时用设置注入（见 configureClient）。
 *   2. **SSE 协议特殊**：所有耗时操作是 `POST + fetch 流式读取`，**不能用
 *      浏览器 EventSource**；HTTP 状态码恒为 200，业务失败只在 `event: error`
 *      里表达 —— 绝不能靠状态码判断成败。
 *
 * 日志一律记 URL 与耗时；URL 会先做脱敏（key/token/secret 等参数值抹掉），
 * 因为这一层未来可能对接带鉴权的端点。
 */
import { AppFailure, errors } from '@main/core/errors'
import { scoped } from '@main/core/logger'
import type {
  RawAccount,
  RawAddressBookResponse,
  RawChatStats,
  RawContact,
  RawGroupInfo,
  RawKeyDirsResponse,
  RawMessage,
  RawMessagesResponse,
  SseEvent,
  SseEventName
} from './types'

const log = scoped('wechat-exp')

/* ==================================================================
 * 0. 客户端级配置
 * ================================================================== */

/** 普通请求的默认超时（毫秒）；service 会用设置里的 ioTimeoutMs 覆盖它 */
let defaultTimeoutMs = 30_000

/** 由 service/index 在启动时注入设置里的 ioTimeoutMs */
export function configureClient(opts: { timeoutMs?: number }): void {
  if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
    defaultTimeoutMs = opts.timeoutMs
  }
}

export function getDefaultTimeoutMs(): number {
  return defaultTimeoutMs
}

/** 单次调用可覆盖超时 */
export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/* ==================================================================
 * 1. URL 与日志辅助
 * ================================================================== */

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

function buildUrl(port: number, path: string, params?: Record<string, unknown>): string {
  const url = new URL(baseUrl(port) + path)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // 空值不传：上游对 "page=" 这类空串可能解析失败，且空值没有任何语义
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

/** 日志用 URL 脱敏：抹掉 key/token/secret/password 之类的参数值 */
function safeLogUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const key of Array.from(u.searchParams.keys())) {
      if (/key|token|secret|password|passwd|pwd/i.test(key)) {
        u.searchParams.set(key, '***')
      }
    }
    return u.toString()
  } catch {
    return url
  }
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'
}

/* ==================================================================
 * 2. 普通 JSON 请求
 * ================================================================== */

interface JsonRequestInit {
  method?: 'GET' | 'POST'
  /** POST 时的 JSON body */
  json?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}

async function fetchJson<T>(
  port: number,
  path: string,
  params: Record<string, unknown> | undefined,
  init: JsonRequestInit = {}
): Promise<T> {
  const url = buildUrl(port, path, params)
  const timeoutMs = init.timeoutMs ?? defaultTimeoutMs
  const ac = new AbortController()
  // 外部 signal 与本地的超时 signal 合并：任一触发即取消
  const onExternalAbort = (): void => ac.abort()
  if (init.signal) {
    if (init.signal.aborted) ac.abort()
    else init.signal.addEventListener('abort', onExternalAbort)
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const started = Date.now()

  try {
    const headers: Record<string, string> = {}
    if (init.json !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: ac.signal
    })
    const text = await res.text()
    if (!res.ok) {
      // 上游 4xx/5xx 通常是 JSON {"error": "..."}（app.py 全局错误处理）
      let msg = `HTTP ${res.status}`
      try {
        const j = JSON.parse(text) as { error?: string }
        if (j && typeof j.error === 'string' && j.error) msg = j.error
      } catch {
        /* 非 JSON 就保留 HTTP 状态码 */
      }
      // 404 单独处理（契约文档 §B.2.2：「表不存在→404」）。
      //
      // /api/messages 的 404 语义是「**这个会话没有消息表**」（多半是群/联系人
      // 在数据库里没有对应分表，属于正常的"没有消息"），不是故障。
      // 以前把它当硬错误抛，于是每个这样的会话**每轮同步都刷一条 ERROR**，
      // 日志被淹没、真正的问题反而看不见。这里改成：记一条 info 并返回空结果，
      // 让上层"读取成功但 0 条"处理。
      // 注意：只对 /api/messages 这么处理——其它端点（stats/group-info 等）的
      // 404 语义不同，仍按错误抛出。
      if (res.status === 404 && path === '/api/messages') {
        log.info('会话没有消息（上游 404，按空结果处理）', {
          chatId: (params as { chat_id?: unknown })?.chat_id,
          详情: msg
        })
        return { messages: [], pagination: { page: 1, per_page: 50, total: 0, total_pages: 1 } } as T
      }
      log.error('wechat_exp 请求失败', {
        url: safeLogUrl(url),
        status: res.status,
        耗时ms: Date.now() - started
      })
      throw errors.external(`wechat_exp 请求失败（${path}）`, msg)
    }
    let data: T
    try {
      data = JSON.parse(text) as T
    } catch {
      throw errors.external(
        `wechat_exp 返回内容不是合法 JSON（${path}）`,
        text.slice(0, 300)
      )
    }
    log.debug('wechat_exp 请求完成', {
      url: safeLogUrl(url),
      耗时ms: Date.now() - started
    })
    return data
  } catch (e) {
    if (e instanceof AppFailure) throw e
    if (isAbortError(e)) {
      throw errors.timeout(`请求 wechat_exp（${path}）`, `超过 ${timeoutMs}ms 未响应`)
    }
    throw errors.external(`请求 wechat_exp 失败（${path}）`, String(e))
  } finally {
    clearTimeout(timer)
    if (init.signal) init.signal.removeEventListener('abort', onExternalAbort)
  }
}

/* ==================================================================
 * 3. 联系人 / 通讯录
 * ================================================================== */

/** `GET /api/contacts?q=` —— 轻量列表，返回 contacts 数组（缺失时为空数组） */
export async function getContacts(
  port: number,
  q?: string,
  opts: RequestOptions = {}
): Promise<RawContact[]> {
  const data = await fetchJson<{ contacts?: RawContact[]; total?: number }>(
    port,
    '/api/contacts',
    { q },
    opts
  )
  if (!Array.isArray(data?.contacts)) {
    log.warn('getContacts 返回体缺少 contacts 数组，按空列表处理', {
      keys: data && typeof data === 'object' ? Object.keys(data) : typeof data
    })
    return []
  }
  return data.contacts
}

export interface AddressBookParams {
  q?: string
  /** 'name' | 'msg_count' | 'last_time' */
  sort?: string
  /** 只取有聊天记录的（1）或没有的（0） */
  hasChat?: 0 | 1 | boolean
  letter?: string
  kind?: 'all' | 'contacts' | 'groups'
  label?: string
  page?: number
  /** 上游上限 500（契约文档 §F.4） */
  perPage?: number
}

/**
 * `GET /api/address-book` —— 完整字段 + 分页。
 * 返回值直接是 **contacts 数组**（调用方已按此约定使用）；分页元信息只记日志，
 * 需要完整分页信息可改用 getAddressBookPage。
 */
export async function getAddressBook(
  port: number,
  params: AddressBookParams = {},
  opts: RequestOptions = {}
): Promise<RawContact[]> {
  const data = await getAddressBookPage(port, params, opts)
  return data.contacts ?? []
}

/** 同上，但保留 `total/page/per_page/total_pages` 等分页元信息 */
export async function getAddressBookPage(
  port: number,
  params: AddressBookParams = {},
  opts: RequestOptions = {}
): Promise<RawAddressBookResponse> {
  const page = Math.max(1, Math.floor(params.page ?? 1))
  // per_page 上限 500：超了会被上游 400 拒绝，这里先夹住
  const perPage = Math.min(500, Math.max(1, Math.floor(params.perPage ?? 100)))
  const hasChat =
    params.hasChat === undefined ? undefined : params.hasChat === true ? 1 : params.hasChat === false ? 0 : params.hasChat

  const data = await fetchJson<RawAddressBookResponse>(
    port,
    '/api/address-book',
    {
      q: params.q,
      sort: params.sort,
      has_chat: hasChat,
      letter: params.letter,
      kind: params.kind,
      label: params.label,
      page,
      per_page: perPage
    },
    opts
  )
  if (!Array.isArray(data?.contacts)) {
    log.warn('getAddressBook 返回体缺少 contacts 数组，按空列表处理')
    return { ...data, contacts: [] }
  }
  return data
}

/* ==================================================================
 * 4. 消息
 * ================================================================== */

export interface MessagesParams {
  chatId: string
  page?: number
  /** 上游上限 200，默认 50 */
  perPage?: number
  /** YYYY-MM-DD */
  startDate?: string
  endDate?: string
  keyword?: string
}

/**
 * `GET /api/messages`。
 * 分页语义：**第 1 页是最新消息**，页内按时间升序。per_page 夹到 1..200。
 */
export async function getMessages(
  port: number,
  params: MessagesParams,
  opts: RequestOptions = {}
): Promise<RawMessagesResponse> {
  const page = Math.max(1, Math.floor(params.page ?? 1))
  // 契约文档 §F.4：per_page 上限 200，越界上游直接 400，这里先夹住
  const perPage = Math.min(200, Math.max(1, Math.floor(params.perPage ?? 50)))

  const data = await fetchJson<RawMessagesResponse>(
    port,
    '/api/messages',
    {
      chat_id: params.chatId,
      page,
      per_page: perPage,
      start_date: params.startDate,
      end_date: params.endDate,
      keyword: params.keyword
    },
    opts
  )
  if (!Array.isArray(data?.messages)) {
    log.warn('getMessages 返回体缺少 messages 数组，按空列表处理', { chatId: params.chatId })
    return { ...data, messages: [] }
  }
  return data
}

export interface AllMessagesParams {
  chatId: string
  startDate?: string
  endDate?: string
  /** 翻页上限，默认 50（防止超大会话把内存/时间拖爆） */
  maxPages?: number
  /** 每页条数，默认 200（上限） */
  perPage?: number
  /** 每翻一页回调一次，便于上报进度 */
  onPage?: (page: number, totalPages: number) => void
}

/**
 * 把一个会话的消息「取全」（在 maxPages 上限内）。
 *
 * 关键：上游第 1 页是最新消息、页码越大越旧，而页内是升序的。
 * 因此要得到「整体按时间升序」的数组，必须把各页按 **页码从大到小** 再拼接。
 * 达到 maxPages 仍未取完时，会记 warn 明确说明「较早消息被截断」，
 * 避免上层误以为拿到了全量。
 */
export async function getAllMessages(
  port: number,
  params: AllMessagesParams,
  opts: RequestOptions = {}
): Promise<RawMessage[]> {
  const maxPages = Math.max(1, Math.floor(params.maxPages ?? 50))
  const perPage = Math.min(200, Math.max(1, Math.floor(params.perPage ?? 200)))

  const pages: RawMessage[][] = []
  let totalPages = 1
  let total = 0
  let truncated = false
  let page = 1

  while (page <= maxPages) {
    const resp = await getMessages(
      port,
      {
        chatId: params.chatId,
        page,
        perPage,
        startDate: params.startDate,
        endDate: params.endDate
      },
      opts
    )
    const msgs = resp.messages ?? []
    pages.push(msgs)
    totalPages = Math.max(1, Math.floor(resp.pagination?.total_pages ?? 1))
    total = Math.max(total, resp.pagination?.total ?? 0)
    params.onPage?.(page, totalPages)

    if (msgs.length === 0 || page >= totalPages) break
    if (page === maxPages) {
      // 走到这一支说明还没翻完就到了上限 → 更早的消息没取到
      truncated = true
      break
    }
    page++
  }

  if (truncated) {
    log.warn('getAllMessages 达到 maxPages 上限，较早消息被截断', {
      chatId: params.chatId,
      maxPages,
      totalPages,
      total,
      已取页数: pages.length,
      约取回条数: pages.length * perPage
    })
  }

  // 页码从大到小拼接，得到全局升序
  const ordered: RawMessage[] = []
  for (let i = pages.length - 1; i >= 0; i--) {
    ordered.push(...pages[i])
  }
  return ordered
}

/** `GET /api/chat/<chat_id>/stats` */
export async function getChatStats(
  port: number,
  chatId: string,
  opts: RequestOptions = {}
): Promise<RawChatStats> {
  return fetchJson<RawChatStats>(
    port,
    `/api/chat/${encodeURIComponent(chatId)}/stats`,
    undefined,
    opts
  )
}

/** `GET /api/chat/<chat_id>/group-info`（非群聊上游会 400） */
export async function getGroupInfo(
  port: number,
  chatId: string,
  opts: RequestOptions = {}
): Promise<RawGroupInfo> {
  return fetchJson<RawGroupInfo>(
    port,
    `/api/chat/${encodeURIComponent(chatId)}/group-info`,
    undefined,
    opts
  )
}

/* ==================================================================
 * 5. SSE 执行器（本层最特殊的一块）
 * ================================================================== */

export interface SseRunOptions {
  /** SSE 默认不设超时（备份/解密可能跑十几分钟）；需要时可显式传入 */
  timeoutMs?: number
  signal?: AbortSignal
}

/** 打开 SSE 流后需要保留的上下文（超时/取消/清理） */
interface SseControl {
  res: Response
  timedOut: () => boolean
  externalAborted: () => boolean
  cleanup: () => void
  started: number
}

/**
 * 发起 SSE 的 POST 请求。
 *
 * 之所以要单独抽出「打开流」与「消费流」两步：`/api/backup/scan` 在不同版本里
 * 既可能是 SSE 也可能是普通 JSON（见 scanAccounts 的注释），需要拿到响应后
 * 依据 Content-Type 再决定怎么读。
 */
async function openSse(
  port: number,
  path: string,
  body: unknown,
  opts: SseRunOptions
): Promise<SseControl> {
  const url = buildUrl(port, path)
  const ac = new AbortController()
  let timedOut = false
  const timeoutMs = opts.timeoutMs ?? 0
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs) : undefined

  const external = opts.signal
  const onExternalAbort = (): void => ac.abort()
  if (external) {
    if (external.aborted) ac.abort()
    else external.addEventListener('abort', onExternalAbort)
  }
  const cleanup = (): void => {
    if (timer) clearTimeout(timer)
    if (external) external.removeEventListener('abort', onExternalAbort)
  }

  const started = Date.now()
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ac.signal
    })
  } catch (e) {
    cleanup()
    if (timedOut) throw errors.timeout(`调用 wechat_exp（${path}）`, `超过 ${timeoutMs}ms`)
    if (external?.aborted) throw errors.external('操作已取消')
    throw errors.external(`请求 wechat_exp 失败（${path}）`, String(e))
  }

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      /* 读不到就算了 */
    }
    cleanup()
    log.error('wechat_exp SSE 请求返回非 2xx', { path, status: res.status, detail })
    throw errors.external(`wechat_exp 返回 HTTP ${res.status}`, detail)
  }

  return {
    res,
    timedOut: () => timedOut,
    externalAborted: () => !!external?.aborted,
    cleanup,
    started
  }
}

/**
 * 解析一个 SSE 事件块（以空行分隔的若干行）。
 * 返回 null 表示这一块应当跳过（无 data 行 / JSON 解析失败）。
 */
function parseSseBlock(block: string, path: string): SseEvent | null {
  if (!block.trim()) return null
  let event: SseEventName = 'progress'
  let id: number | undefined
  const dataLines: string[] = []

  for (const line of block.split('\n')) {
    if (!line) continue
    // ':' 开头是注释（上游 keepalive 也会用 ':' 开头），直接忽略
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // SSE 规范：冒号后可选一个空格，需去掉
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') event = value as SseEventName
    else if (field === 'data') dataLines.push(value)
    else if (field === 'id') {
      const n = Number(value)
      if (Number.isFinite(n)) id = n
    }
  }

  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    // 上游偶尔可能发非 JSON 的 data（历史版本），跳过它但记 warn
    log.warn('SSE data 行 JSON 解析失败，已跳过该事件', { path, 片段: raw.slice(0, 200) })
    return null
  }
  return { event, data, id }
}

/**
 * 消费一个已打开的 SSE 响应。
 *
 * 协议要点（契约文档 §B.4）：
 *   - 事件语法 `id: N\nevent: <name>\ndata: <json>\n\n`，以空行分隔
 *   - **HTTP 恒 200**，业务失败只体现为 `event: error`，所以这里只认事件本身
 *   - `done` 的 data.result 才是真正的返回值
 *   - `select` 表示「同名会话需要二选一」，上游随后即结束流
 */
async function consumeSse(
  res: Response,
  path: string,
  onEvent: (e: SseEvent) => void,
  ctl: SseControl
): Promise<any> {
  if (!res.body) {
    throw errors.external(`wechat_exp 未返回响应体（${path} 可能不是 SSE 端点）`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let result: unknown
  let gotDone = false
  let gotError: string | null = null
  let selectData: any = null

  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (e) {
        if (ctl.timedOut()) throw errors.timeout(`wechat_exp 操作（${path}）`)
        if (ctl.externalAborted()) throw errors.external('操作已取消')
        throw errors.external('读取 wechat_exp 事件流失败', String(e))
      }
      if (chunk.done) break

      // 逐块解码（stream:true 处理跨块的多字节字符），并把 CRLF 归一化，
      // 这样「按空行切分事件」在 \r\n\r\n 场景下也成立。
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n')

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const evt = parseSseBlock(block, path)
        if (!evt) continue

        try {
          onEvent(evt)
        } catch (e) {
          // 回调是外部的，抛错不应中断协议解析
          log.warn('SSE onEvent 回调抛错（已忽略）', { path, 错误: String(e) })
        }

        if (evt.event === 'done') {
          gotDone = true
          result = evt.data?.result
          break
        }
        if (evt.event === 'error') {
          gotError = String(evt.data?.message ?? '未知错误')
          break
        }
        if (evt.event === 'select') {
          // 记录下来但不立即中断：上游会在 select 之后关闭流
          selectData = evt.data
        }
        // progress / heartbeat 无需特殊处理，已通过 onEvent 交给调用方
      }

      if (gotDone || gotError) break
    }
  } finally {
    // done/error 之后上游会再放一个 None 结束生成器；这里主动取消读取，
    // 避免连接悬挂，也能尽早释放资源。
    try {
      await reader.cancel()
    } catch {
      /* 流可能已经结束，取消失败可忽略 */
    }
  }

  const elapsed = Date.now() - ctl.started
  if (gotError) {
    log.error('wechat_exp SSE 业务失败', { path, 耗时ms: elapsed, 错误: gotError })
    // 用上游给的中文 message 作为用户可见提示（如「微信未运行」/「密钥错误」）
    throw errors.external(gotError, `event: error（${path}）`)
  }
  if (gotDone) {
    log.debug('wechat_exp SSE 完成', { path, 耗时ms: elapsed })
    return result
  }
  if (selectData) {
    const matches = selectData?.matches
    log.warn('wechat_exp 需要人工选择数据目录（select 事件）', { path, matches })
    throw errors.external(
      '需要选择微信数据目录（wechat_exp 返回了 select 事件）',
      JSON.stringify(matches ?? selectData).slice(0, 1000)
    )
  }
  log.warn('wechat_exp SSE 流意外结束（未收到 done/error）', { path, 耗时ms: elapsed })
  throw errors.external('wechat_exp 操作提前结束（未收到完成事件），请查看日志')
}

/**
 * SSE 执行器。
 *
 * - 用 `fetch` POST，流式读取 `response.body`，按 `\n\n` 切分事件块
 * - 收到 `event: done` → resolve 其 `data.result`
 * - 收到 `event: error` → reject，错误信息用 `data.message`（中文）
 * - 解析不了的 data 块记 warn 并跳过
 * - 支持 `AbortSignal` 取消
 * - 默认不设超时（耗时操作可能很久），可用 opts.timeoutMs 指定
 *
 * 再次强调：这些端点的 HTTP 状态码**恒为 200**，成败只能靠事件判断。
 */
export async function runSse(
  port: number,
  path: string,
  body: unknown,
  onEvent: (e: SseEvent) => void,
  opts: SseRunOptions = {}
): Promise<any> {
  const ctl = await openSse(port, path, body, opts)
  try {
    return await consumeSse(ctl.res, path, onEvent, ctl)
  } finally {
    ctl.cleanup()
  }
}

/* ==================================================================
 * 6. 备份 / 密钥 / 健康
 * ================================================================== */

function extractAccounts(data: any): RawAccount[] {
  if (data && Array.isArray(data.accounts)) return data.accounts as RawAccount[]
  log.warn('scanAccounts 返回体缺少 accounts 数组，按空列表处理', {
    keys: data && typeof data === 'object' ? Object.keys(data) : typeof data
  })
  return []
}

/**
 * `POST /api/backup/scan` —— 探测本机微信账号数据目录。
 *
 * ⚠️ 契约文档 §B.2.5 写的是「普通 JSON，不是 SSE」，但参考源码
 * （`web/routes/backup_api.py` 的 `backup_scan`）**实际用的是 SSE**
 * （前端 `backup.html` 也是用 `SseProgress('/api/backup/scan')` 调它），
 * done 事件的 result 才是 `{"accounts":[...]}`。
 * 不同打包版本可能不一致，这里按响应的 Content-Type 分派，两种都能吃。
 */
export async function scanAccounts(
  port: number,
  opts: SseRunOptions = {}
): Promise<RawAccount[]> {
  const ctl = await openSse(port, '/api/backup/scan', {}, opts)
  try {
    const contentType = ctl.res.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const result = await consumeSse(ctl.res, '/api/backup/scan', () => {}, ctl)
      return extractAccounts(result)
    }
    const text = await ctl.res.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw errors.external('scanAccounts 返回内容无法解析', text.slice(0, 300))
    }
    return extractAccounts(data)
  } finally {
    ctl.cleanup()
  }
}

export type KeyDirMode = 'fast' | 'auto' | 'deep'

/** `GET /api/keys/dirs?mode=` —— 候选微信数据目录（用于引导用户选目录） */
export async function getKeyDirs(
  port: number,
  mode: KeyDirMode = 'auto',
  opts: RequestOptions = {}
): Promise<RawKeyDirsResponse> {
  const data = await fetchJson<RawKeyDirsResponse>(
    port,
    '/api/keys/dirs',
    { mode },
    opts
  )
  if (!Array.isArray(data?.dirs)) {
    log.warn('getKeyDirs 返回体缺少 dirs 数组，按空列表处理')
    return { ...data, dirs: [] }
  }
  return data
}

/**
 * 探活：任何 HTTP 响应（哪怕 404/500）都算「服务已起来」。
 * 用 `/` 而不是 `/api/contacts`，因为前者是静态页、响应快且不依赖解密数据。
 *
 * ⚠️ 注意：这个函数**只回答「端口上有没有 HTTP 应答者」**，
 * 不能用来判断「应答者是不是我们自己的 wechat_exp 子进程」——
 * 若该端口被别的服务占用，它同样会返回 true。
 * 「确认是自己人」请用下面的 pingWechatExp()。
 */
export async function ping(port: number, timeoutMs = 2000): Promise<boolean> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 严格探活：不仅要求有响应，还要求**响应方确实是 wechat_exp**。
 *
 * 为什么需要它：
 *   用户在设置里显式指定了 wechatExpPort 时，该端口可能已被别的服务占用。
 *   此时 ping() 会因「有 HTTP 应答」而返回 true，让 startService 误以为启动成功，
 *   而真正 spawn 出来的子进程其实已经退出——后续所有请求都会打到那台外部服务上。
 *
 * 判据：上游 `/` 返回的是带 "WeChat EXP" 字样的静态页（title 与页脚都有）。
 * 用这个特征把「我们的子进程」和「恰好占用该端口的别的服务」区分开。
 *
 * 返回：
 *   null            —— 没响应（端口空闲 / 服务没起来）
 *   { ours: false } —— 有响应但不是 wechat_exp
 *   { ours: true }  —— 确认是我们的 wechat_exp
 */
export async function pingWechatExp(
  port: number,
  timeoutMs = 2000
): Promise<{ ours: boolean; body: string } | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal })
    // 读不到 body 时不能自证身份，此时按「不是自己人」处理（宁可多等一轮，也不误判）
    let body = ''
    try {
      body = (await res.text()).slice(0, 4000)
    } catch {
      body = ''
    }
    return { ours: /wechat\s*exp/i.test(body), body }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
