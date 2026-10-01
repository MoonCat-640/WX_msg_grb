/**
 * LLM 平台静态配置表（模型清单 / 价格 / 控制台地址 / 调用方式）
 * ==================================================================
 * 【重要】模型 id 与价格会随官方随时调整，这里全部是「配置项」：
 *   需要新增模型、改价、换 baseUrl 时，只改本文件即可，其它代码不用动。
 *
 * 价格说明：
 *   - 单位统一为「元 / 百万 token」，与 @shared/types 里 LlmModelInfo 的约定一致；
 *   - 全部是 ≈ 近似值（美元价按约 7.2 汇率折算后取整），只用于
 *     「按价格从低到高排序」「挑最便宜的默认模型」这类相对比较，不作为对账依据；
 *   - 每个平台的 models 数组必须「按输入价从低到高」排列，且 defaultModel === models[0].id。
 *
 * 协议说明：
 *   - DeepSeek / OpenAI / 通义千问 / 文心一言 / Gemini 都走 OpenAI 兼容的
 *     POST {baseUrl}/chat/completions，鉴权用 Authorization: Bearer <key>；
 *   - Claude 走 Anthropic Messages API 的 POST {baseUrl}/messages，
 *     鉴权用 x-api-key，且必须带 anthropic-version 头（见 client.ts）。
 */
import type { LlmModelInfo, LlmProviderDescriptor, LlmProviderId } from '@shared/types'
import type { ProviderRuntime } from './types'

/**
 * 构造一个模型条目。
 * 刻意不用「美元 × 汇率」的写法：国产平台（DeepSeek/通义/文心）本来就是人民币计价，
 * 混算反而容易看错，所以这里一律直接写「元/百万 token」。
 */
function model(
  id: string,
  label: string,
  inputPricePerM: number,
  outputPricePerM: number,
  supportsJson: boolean,
  note?: string
): LlmModelInfo {
  return { id, label, inputPricePerM, outputPricePerM, supportsJson, note }
}

/* ==================================================================
 * 1. 平台元信息（给界面展示）+ 模型清单（给调用层挑模型）
 * ================================================================== */

export const PROVIDERS: Record<LlmProviderId, LlmProviderDescriptor> = {
  /* ---------------- DeepSeek ---------------- */
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    color: '#4D6BFE',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: '以 sk- 开头的一串字符',
    keyPattern: '^sk-[A-Za-z0-9]{20,}$',
    // defaultModel 必须等于 models 里最便宜的那个（models[0]）
    defaultModel: 'deepseek-chat',
    models: [
      model('deepseek-chat', 'DeepSeek Chat', 2, 8, true, '性价比最高，日常任务抽取足够'),
      model('deepseek-reasoner', 'DeepSeek Reasoner', 4, 16, true, '带思维链，更贵更慢，只在难例上用')
    ],
    implemented: true
  },

  /* ---------------- OpenAI ---------------- */
  openai: {
    id: 'openai',
    label: 'ChatGPT',
    color: '#10A37F',
    consoleUrl: 'https://platform.openai.com/api-keys',
    keyHint: '以 sk- 或 sk-proj- 开头的字符串',
    keyPattern: '^sk-[A-Za-z0-9_-]{20,}$',
    defaultModel: 'gpt-4o-mini',
    models: [
      model('gpt-4o-mini', 'GPT-4o mini', 1.1, 4.3, true, '便宜且稳定（≈$0.15/$0.60 每百万）'),
      model('gpt-4.1-mini', 'GPT-4.1 mini', 2.9, 11.5, true, '上下文更长（≈$0.40/$1.60 每百万）'),
      model('gpt-4o', 'GPT-4o', 18, 72, true, '能力最强、价格最高（≈$2.5/$10 每百万）')
    ],
    implemented: true
  },

  /* ---------------- 通义千问（阿里云百炼 / 灵积） ---------------- */
  qwen: {
    id: 'qwen',
    label: '通义千问',
    color: '#615CED',
    consoleUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    keyHint: '以 sk- 开头的 DashScope API Key',
    keyPattern: '^sk-[A-Za-z0-9]{20,}$',
    defaultModel: 'qwen-turbo',
    models: [
      model('qwen-turbo', '通义千问 Turbo', 0.3, 0.6, true, '最便宜，适合大批量抽取'),
      model('qwen-plus', '通义千问 Plus', 0.8, 2, true, '价格与质量均衡'),
      model('qwen-max', '通义千问 Max', 2.4, 9.6, true, '效果最好，仅难例使用')
    ],
    implemented: true
  },

  /* ---------------- 文心一言（百度千帆 V2） ---------------- */
  ernie: {
    id: 'ernie',
    label: '文心一言',
    color: '#2932E1',
    consoleUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    keyHint: '百度千帆 API Key（形如 bce-v3/ALTAK-...）',
    // 千帆 Key 的形态随账号类型不同（bce-v3/... 等），做正则容易误杀，故不提供 keyPattern
    defaultModel: 'ernie-speed-128k',
    models: [
      model('ernie-speed-128k', '文心 Speed 128K', 0, 0, true, '官方长期免费额度，适合大批量'),
      model('ernie-4.0-turbo-8k', '文心 4.0 Turbo 8K', 30, 90, true, '效果更好，按时长计价偏贵')
    ],
    implemented: true
  },

  /* ---------------- Gemini（Google AI Studio） ---------------- */
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    color: '#4285F4',
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: '以 AIza 开头的 Google AI Studio API Key',
    keyPattern: '^AIza[A-Za-z0-9_-]{20,}$',
    // 1.5-flash 单价低于 2.0-flash，按「最便宜 = 默认」的约定取它
    defaultModel: 'gemini-1.5-flash',
    models: [
      model('gemini-1.5-flash', 'Gemini 1.5 Flash', 0.5, 2.2, true, '最便宜（≈$0.075/$0.30 每百万）'),
      model('gemini-2.0-flash', 'Gemini 2.0 Flash', 0.7, 2.9, true, '新一代，速度与质量更好（≈$0.10/$0.40 每百万）')
    ],
    implemented: true
  },

  /* ---------------- Claude（Anthropic） ---------------- */
  claude: {
    id: 'claude',
    label: 'Claude',
    color: '#D97757',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: '以 sk-ant- 开头的字符串',
    keyPattern: '^sk-ant-[A-Za-z0-9_-]{20,}$',
    defaultModel: 'claude-haiku-4-5',
    models: [
      model('claude-haiku-4-5', 'Claude Haiku 4.5', 7.2, 36, true, '最便宜且快（≈$1/$5 每百万）'),
      model('claude-sonnet-5', 'Claude Sonnet 5', 14.4, 72, true, '均衡之选（≈$2/$10 每百万）'),
      model('claude-opus-5-5', 'Claude Opus 5.5', 28.8, 144, true, '能力最强、最贵（≈$4/$20 每百万）')
    ],
    implemented: true
  }
}

/**
 * 界面展示顺序（与需求一致）：DeepSeek → ChatGPT → 通义千问 → 文心一言 → Gemini → Claude。
 * 用显式数组而不是 Object.values(PROVIDERS)，是为了让顺序成为「契约」而不是依赖对象键序。
 */
export const PROVIDER_LIST: LlmProviderDescriptor[] = [
  PROVIDERS.deepseek,
  PROVIDERS.openai,
  PROVIDERS.qwen,
  PROVIDERS.ernie,
  PROVIDERS.gemini,
  PROVIDERS.claude
]

/* ==================================================================
 * 2. 运行时调用配置（给 client.ts 用）
 * ================================================================== */

export const PROVIDER_RUNTIME: Record<LlmProviderId, ProviderRuntime> = {
  deepseek: {
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiStyle: 'openai',
    jsonObjectMode: true
  },
  openai: {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiStyle: 'openai',
    jsonObjectMode: true
  },
  qwen: {
    id: 'qwen',
    // 阿里云百炼（灵积）的 OpenAI 兼容端点
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiStyle: 'openai',
    jsonObjectMode: true
  },
  ernie: {
    id: 'ernie',
    // 百度千帆 V2 的 OpenAI 兼容端点
    baseUrl: 'https://qianfan.baidubce.com/v2',
    apiStyle: 'openai',
    jsonObjectMode: true
  },
  gemini: {
    id: 'gemini',
    // Gemini 的 OpenAI 兼容端点，鉴权同样走 Authorization: Bearer <key>
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiStyle: 'openai',
    jsonObjectMode: true
  },
  claude: {
    id: 'claude',
    // Anthropic Messages API（非 OpenAI 兼容），路径为 /messages
    baseUrl: 'https://api.anthropic.com/v1',
    apiStyle: 'anthropic',
    // Claude 用顶层 system 字段 + 提示词约束来产出 JSON，不支持 response_format
    jsonObjectMode: false
  }
}
