/**
 * LLM 统一调用客户端
 * ==================================================================
 * 对外只暴露两个能力：
 *   - chat()    ：单次对话请求（六家平台走同一套入口，内部按协议风格分流）
 *   - testKey() ：校验 Key 是否可用（发一个极小请求，永不抛异常）
 * 另导出 maskKey() 供日志/界面脱敏复用。
 *
 * 设计要点：
 *   1. 只用 Node 内置的全局 fetch（Electron 主进程自带），不引入任何 npm 依赖；
 *   2. 超时统一用 AbortController 实现，超时抛 errors.timeout(...)，方便界面统一提示；
 *   3. 错误一律包成 AppFailure（见 core/errors.ts），message 是给用户看的中文，
 *      detail 里才放 HTTP 状态码与响应片段（响应体截断到 500 字符）；
 *   4. 日志只记录 provider / model / 耗时 / 失败原因，**API Key 最多以 maskKey 打码形式出现**，
 *      消息正文也不落日志（聊天内容涉及隐私）。
 */
import type { LlmProviderId } from '@shared/types'
import { AppFailure, errors } from '@main/core/errors'
import { scoped } from '@main/core/logger'
import { PROVIDERS, PROVIDER_RUNTIME } from './providers'
import type { ChatRequest, ChatResponse, KeyTestResult, ProviderRuntime } from './types'

const log = scoped('llm')

/** 默认超时：30 秒（需求约定），可被 ChatRequest.timeoutMs 覆盖 */
const DEFAULT_TIMEOUT_MS = 30_000
/** 默认温度：0.2（任务抽取要稳定，不要发散） */
const DEFAULT_TEMPERATURE = 0.2
/** 默认最大输出 token */
const DEFAULT_MAX_TOKENS = 2048
/** Anthropic Messages API 版本头，官方要求必带 */
const ANTHROPIC_VERSION = '2023-06-01'
/** 出错时写进 detail 的响应体片段上限，避免把整个 HTML 错误页塞进日志 */
const BODY_SNIPPET_LIMIT = 500
/** jsonMode 下给 Claude 追加的指令（Claude 没有 response_format，只能靠提示词约束） */
const JSON_ONLY_INSTRUCTION =
  '请只输出一个合法的 JSON 对象，不要输出任何解释性文字，也不要用 Markdown 代码块包裹。'

/**
 * 内置的官方根地址快照。
 *
 * 在模块加载时从 PROVIDER_RUNTIME 算一次并存成集合，之后请求前拿实际用到的
 * baseUrl 与它比对（见 chat() 里的安全闸门）。
 * providers.ts 若保持"静态表"的约定（其文件头注释已强制要求），这个快照就永远精确；
 * 一旦有人在运行时改写了某个平台的 baseUrl，比对失败 → 拒绝发送 Key。
 */
const ALLOWED_BASE_URLS: ReadonlySet<string> = new Set(
  Object.values(PROVIDER_RUNTIME).map((r) => r.baseUrl)
)

/* ==================================================================
 * 1. 脱敏
 * ================================================================== */

/**
 * Key 脱敏：返回「前 4 位 + **** + 后 4 位」。
 * 长度不足 12 时全部打码——否则短 Key 的前 4 位加后 4 位就等于把整串暴露了。
 */
export function maskKey(key: string): string {
  const k = typeof key === 'string' ? key.trim() : ''
  if (k.length < 12) return '****'
  return `${k.slice(0, 4)}****${k.slice(-4)}`
}

/* ==================================================================
 * 2. 请求体组装
 * ================================================================== */

type JsonObject = Record<string, unknown>

/** OpenAI 兼容协议：system 作为 messages[0] 传入 */
function buildOpenAiBody(
  req: ChatRequest,
  runtime: ProviderRuntime,
  model: string,
  temperature: number,
  maxTokens: number
): JsonObject {
  const messages: { role: string; content: string }[] = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  for (const m of req.messages) messages.push({ role: m.role, content: m.content })

  const body: JsonObject = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens
  }
  // 只有平台声明支持时才带 response_format，否则会直接 400
  if (req.jsonMode && runtime.jsonObjectMode) {
    body.response_format = { type: 'json_object' }
  }
  return body
}

/**
 * 新一代 Claude（Sonnet 5、Opus 4.7/4.8/5/5.5、Fable、Mythos）已移除采样参数，
 * 带上 temperature 会直接返回 400；Haiku 4.5 及更早的模型仍然接受。
 * 因此在 Claude 分支里按模型名决定要不要带 temperature。
 */
function anthropicAcceptsTemperature(model: string): boolean {
  return !/^claude-(fable|mythos|opus-5|opus-4-(7|8)|sonnet-5)/.test(model)
}

/** Anthropic Messages API：system 是顶层字段，max_tokens 必填 */
function buildAnthropicBody(
  req: ChatRequest,
  model: string,
  temperature: number,
  maxTokens: number
): JsonObject {
  const body: JsonObject = {
    model,
    // Anthropic 的 max_tokens 是必填项，不传会 400
    max_tokens: maxTokens,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content }))
  }

  let system = req.system?.trim() ?? ''
  if (req.jsonMode) {
    system = system ? `${system}\n\n${JSON_ONLY_INSTRUCTION}` : JSON_ONLY_INSTRUCTION
  }
  if (system) body.system = system

  if (anthropicAcceptsTemperature(model)) body.temperature = temperature
  return body
}

function buildHeaders(runtime: ProviderRuntime, apiKey: string): Record<string, string> {
  const base: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  }
  if (runtime.apiStyle === 'anthropic') {
    // Anthropic 用 x-api-key，而不是 Bearer
    return { ...base, 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
  }
  return { ...base, authorization: `Bearer ${apiKey}` }
}

function endpointOf(runtime: ProviderRuntime): string {
  return `${runtime.baseUrl}${runtime.apiStyle === 'anthropic' ? '/messages' : '/chat/completions'}`
}

/* ==================================================================
 * 3. 响应解析
 * ================================================================== */

interface ParsedReply {
  text: string
  model?: string
  inputTokens?: number
  outputTokens?: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseOpenAiReply(data: any, fallbackModel: string): ParsedReply {
  const choice = data?.choices?.[0]
  const content = choice?.message?.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    // 少数兼容实现会把 content 返回成 [{type:'text',text:'...'}] 的分段结构
    text = content.map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
  }
  if (!text && typeof choice?.text === 'string') text = choice.text

  return {
    text,
    model: typeof data?.model === 'string' ? data.model : fallbackModel,
    inputTokens: data?.usage?.prompt_tokens,
    outputTokens: data?.usage?.completion_tokens
  }
}

function parseAnthropicReply(data: any, fallbackModel: string): ParsedReply {
  // 取第一个 text 块（正常情况下就是 content[0]）
  const blocks: any[] = Array.isArray(data?.content) ? data.content : []
  const textBlock = blocks.find((b) => b?.type === 'text' && typeof b?.text === 'string')

  return {
    text: textBlock ? textBlock.text : '',
    model: typeof data?.model === 'string' ? data.model : fallbackModel,
    inputTokens: data?.usage?.input_tokens,
    outputTokens: data?.usage?.output_tokens
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ==================================================================
 * 4. HTTP 收发与统一错误处理
 * ================================================================== */

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text
}

/** 把 HTTP 状态码翻译成用户能看懂的中文（detail 里保留原始响应片段供排查） */
function httpFailure(status: number, snippet: string): AppFailure {
  const detail = `HTTP ${status}: ${snippet}`
  if (status === 401 || status === 403) {
    return new AppFailure(
      'llm_http_error',
      'API Key 无效或权限不足，请检查密钥是否正确、是否已开通该模型',
      detail
    )
  }
  if (status === 429) {
    return new AppFailure(
      'llm_http_error',
      '请求过于频繁（已触发平台限流），请稍后重试或降低并发',
      detail
    )
  }
  if (status >= 500) {
    return new AppFailure('llm_http_error', `模型服务暂时不可用（HTTP ${status}），请稍后重试`, detail)
  }
  return new AppFailure('llm_http_error', `调用模型失败（HTTP ${status}），详情见日志`, detail)
}

/**
 * 发一个 JSON POST 并返回解析后的响应体。
 * 超时与外部取消都通过 AbortController 汇聚到同一个 signal 上；
 * 用 timedOut 标记区分「超时」和「调用方主动取消」，两者的提示语完全不同。
 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  label: string
): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = (): void => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', forwardAbort)
  }

  let res: Response
  let text: string
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
    // 无论成功失败都先读文本：非 2xx 时这段文本是排查问题的唯一线索
    text = await res.text()
  } catch (e) {
    if (timedOut) throw errors.timeout(label, `超过 ${timeoutMs}ms 未返回`)
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new AppFailure('llm_aborted', '请求已取消', '调用方传入的 signal 触发了中止')
    }
    throw new AppFailure(
      'llm_network_error',
      '无法连接模型服务，请检查网络或代理设置',
      e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    )
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort)
  }

  const snippet = truncate(text, BODY_SNIPPET_LIMIT)
  if (!res.ok) throw httpFailure(res.status, snippet)

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AppFailure('llm_bad_response', '模型服务返回了无法解析的内容', `HTTP ${res.status}: ${snippet}`)
  }
}

/* ==================================================================
 * 5. 对外 API
 * ================================================================== */

/** 单次对话请求 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const runtime = PROVIDER_RUNTIME[req.provider]
  if (!runtime) throw errors.invalidArg(`不支持的 LLM 平台：${req.provider}`)
  if (!req.apiKey) throw errors.invalidArg('缺少 API Key，请先在设置中填写')

  // 安全闸门：只允许把 API Key 送往内置的官方根地址。
  //
  // 为什么需要这道检查：
  //   PROVIDER_RUNTIME 是模块级可变对象，任何人都能在运行时改掉某个平台的
  //   baseUrl。一旦被改成第三方主机，buildHeaders() 会把**明文 API Key**
  //   原样发过去——这是典型的密钥外泄路径（本地恶意代码 / 被篡改的插件都能做到）。
  //
  // 做法：把内置的官方地址在模块加载时快照成一个只读集合，请求前比对。
  // 不匹配就失败关闭（fail-closed），而不是「继续但去掉 Key」——
  // 后者会让人以为只是配置错了，实际上调用已经打到不可信的主机上了。
  if (!ALLOWED_BASE_URLS.has(runtime.baseUrl)) {
    log.error('拒绝向非内置地址发送 API Key', {
      provider: req.provider,
      baseUrl: runtime.baseUrl
    })
    throw new AppFailure(
      'llm_untrusted_base_url',
      `平台 ${PROVIDERS[req.provider].label} 的接口地址不是官方地址，已拒绝调用（以保护你的 API Key）`,
      `期望的官方地址之一：${Array.from(ALLOWED_BASE_URLS).join(' / ')}；实际：${runtime.baseUrl}`
    )
  }

  const model = req.model || PROVIDERS[req.provider].defaultModel
  const temperature = req.temperature ?? DEFAULT_TEMPERATURE
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const label = `调用 ${PROVIDERS[req.provider].label} 模型`

  const body =
    runtime.apiStyle === 'anthropic'
      ? buildAnthropicBody(req, model, temperature, maxTokens)
      : buildOpenAiBody(req, runtime, model, temperature, maxTokens)

  log.debug('发起模型请求', {
    provider: req.provider,
    model,
    apiStyle: runtime.apiStyle,
    temperature,
    maxTokens,
    timeoutMs,
    jsonMode: !!req.jsonMode,
    消息条数: req.messages.length,
    key: maskKey(req.apiKey)
  })

  const started = Date.now()
  let data: unknown
  try {
    data = await postJson(
      endpointOf(runtime),
      buildHeaders(runtime, req.apiKey),
      body,
      timeoutMs,
      req.signal,
      label
    )
  } catch (e) {
    const latencyMs = Date.now() - started
    log.error('模型请求失败', {
      provider: req.provider,
      model,
      耗时ms: latencyMs,
      code: e instanceof AppFailure ? e.code : 'unexpected',
      原因: e instanceof Error ? e.message : String(e),
      detail: e instanceof AppFailure ? e.detail : undefined,
      key: maskKey(req.apiKey)
    })
    throw e
  }

  const parsed =
    runtime.apiStyle === 'anthropic' ? parseAnthropicReply(data, model) : parseOpenAiReply(data, model)
  const latencyMs = Date.now() - started

  if (!parsed.text) {
    // 返回空文本通常是触发了内容过滤或被 max_tokens 截断，单独记一条 warn 便于排查
    log.warn('模型返回了空文本', { provider: req.provider, model: parsed.model ?? model, 耗时ms: latencyMs })
  }
  log.info('模型请求成功', {
    provider: req.provider,
    model: parsed.model ?? model,
    耗时ms: latencyMs,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    输出字符数: parsed.text.length
  })

  return {
    text: parsed.text,
    model: parsed.model ?? model,
    usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens },
    latencyMs,
    raw: data
  }
}

/**
 * 校验 Key 是否可用：发一个「你好」+ 极小 max_tokens 的请求。
 * 这个函数**不抛异常**——结果要直接展示给用户，失败也走返回值。
 * 未指定 model 时用该平台最便宜的模型（defaultModel），校验成本最低。
 */
export async function testKey(
  provider: LlmProviderId,
  apiKey: string,
  model?: string
): Promise<KeyTestResult> {
  const useModel = model || PROVIDERS[provider]?.defaultModel || ''

  if (!PROVIDER_RUNTIME[provider]) {
    return { ok: false, message: `不支持的 LLM 平台：${provider}`, model: useModel, latencyMs: 0 }
  }
  if (!apiKey) {
    return { ok: false, message: '请先填写 API Key', model: useModel, latencyMs: 0 }
  }

  const started = Date.now()
  log.info('开始校验 API Key', { provider, model: useModel, key: maskKey(apiKey) })

  try {
    const res = await chat({
      provider,
      apiKey,
      model: useModel,
      messages: [{ role: 'user', content: '你好' }],
      // 校验只需要「能连通 + 能鉴权」这一个信号，所以把输出压到最小；
      // 但不用 max_tokens=1——部分平台对过小的值会直接报错或返回空，反而误判为失败。
      maxTokens: 8,
      temperature: 0
    })
    log.info('API Key 校验通过', { provider, model: res.model, 耗时ms: res.latencyMs })
    return { ok: true, message: '连接成功，模型可用', model: res.model, latencyMs: res.latencyMs }
  } catch (e) {
    // 这里必须吞掉异常：AppFailure.message 已经是中文用户提示，其它异常给通用兜底文案
    const message = e instanceof AppFailure ? e.message : '校验失败，请稍后重试'
    const latencyMs = Date.now() - started
    log.warn('API Key 校验未通过', {
      provider,
      model: useModel,
      耗时ms: latencyMs,
      原因: message,
      detail: e instanceof AppFailure ? e.detail : undefined
    })
    return { ok: false, message, model: useModel, latencyMs }
  }
}