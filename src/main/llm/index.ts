/**
 * LLM 多平台适配层 —— 统一出口
 * ==================================================================
 * 上层（IPC handler、任务抽取流水线）只从这里 import，不要深入具体文件，
 * 这样将来换实现（比如加缓存、加重试）时只改本层的内部结构即可。
 *
 * 对外可见的东西：
 *   - PROVIDERS / PROVIDER_LIST ：平台元信息与模型清单（界面展示 + 挑模型）
 *   - chat()                    ：单次对话请求
 *   - testKey()                 ：校验 Key（不抛异常，结果直接展示给用户）
 *   - maskKey()                 ：Key 脱敏
 *   - 类型                      ：本层自己的类型 + 顺带重导出的 shared 类型
 */
export { PROVIDERS, PROVIDER_LIST, PROVIDER_RUNTIME } from './providers'
export { chat, testKey, maskKey } from './client'

export type {
  ChatRequest,
  ChatResponse,
  KeyTestResult,
  ChatMessageInput,
  LlmApiStyle,
  ProviderRuntime
} from './types'

// 顺带重导出调用方常用的共享类型，省得再写一行 @shared/types 的 import
export type { LlmProviderDescriptor, LlmProviderId, LlmModelInfo, LlmKeyRecord } from '@shared/types'
