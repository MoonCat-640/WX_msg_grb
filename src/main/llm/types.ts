/**
 * LLM 多平台适配层 —— 类型定义
 * ------------------------------------------------------------------
 * 这一层刻意只依赖 Node 内置能力（全局 fetch / AbortController），
 * 不 import electron，因此可以在纯 Node 环境下直接跑单元测试。
 *
 * 与 @shared/types 的分工：
 *   - @shared/types 里的 LlmProviderDescriptor / LlmModelInfo 是「给界面看的」
 *     （颜色、申请地址、模型价格），被渲染进程一起引用，所以放在 shared；
 *   - 本文件里的是「给网络层看的」内部结构（协议风格、请求/响应形状），
 *     只属于主进程，不需要也不应该暴露给渲染进程。
 */
import type { LlmProviderId } from '@shared/types'

/**
 * 调用协议风格。
 * 目前只有两种：
 *   - 'openai'    ：OpenAI 的 POST /chat/completions（DeepSeek / OpenAI / 通义 / 文心 / Gemini 均兼容此格式）
 *   - 'anthropic' ：Anthropic 的 POST /messages（只有 Claude 用，system 是顶层字段而非 message）
 */
export type LlmApiStyle = 'openai' | 'anthropic'

/**
 * 平台的运行时调用配置。
 * 和 LlmProviderDescriptor 分开保存：后者是给界面展示的静态元信息，
 * 前者是网络层真正要用的东西（根地址、协议风格、能力开关），两者变更频率完全不同。
 */
export interface ProviderRuntime {
  id: LlmProviderId
  /** API 根地址；末尾不带斜杠，且已包含版本段（如 /v1） */
  baseUrl: string
  apiStyle: LlmApiStyle
  /**
   * 是否支持 OpenAI 的 response_format:{type:'json_object'}。
   * 各平台兼容度不一致，做成开关而不是写死判断，出问题时改这一个值即可。
   */
  jsonObjectMode: boolean
}

/** 对话消息（不含 system；system 由 ChatRequest.system 单独传） */
export interface ChatMessageInput {
  role: 'user' | 'assistant'
  content: string
}

/** 单次对话请求 */
export interface ChatRequest {
  provider: LlmProviderId
  apiKey: string
  model: string
  /** 系统提示词 */
  system?: string
  /** 对话消息（不含 system） */
  messages: ChatMessageInput[]
  /** 采样温度，默认 0.2（任务抽取要稳定） */
  temperature?: number
  /** 最大输出 token，默认 2048 */
  maxTokens?: number
  /** 超时毫秒，默认 30000 */
  timeoutMs?: number
  /** 要求返回 JSON 对象（各平台实现方式不同，见下） */
  jsonMode?: boolean
  /** 外部取消信号 */
  signal?: AbortSignal
}

export interface ChatResponse {
  text: string
  model: string
  usage?: { inputTokens?: number; outputTokens?: number }
  latencyMs: number
  /** 原始响应（调试用，可裁剪） */
  raw?: unknown
}

/**
 * testKey 的返回体。
 * 注意：这个函数「不抛异常」——它的结果要直接展示给用户，
 * 因此失败原因也走 message 字段返回，而不是 throw。
 */
export interface KeyTestResult {
  ok: boolean
  message: string
  model: string
  latencyMs: number
}
