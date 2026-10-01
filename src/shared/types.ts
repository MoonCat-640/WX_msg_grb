/**
 * 全局共享类型定义
 * ------------------------------------------------------------------
 * 该文件被「主进程 / 预加载 / 渲染进程」三方共同引用，
 * 是整个项目的契约中心。修改这里的类型必须同步检查：
 *   - src/shared/ipc.ts         （IPC 通道契约）
 *   - src/main/**               （主进程实现）
 *   - src/renderer/src/**       （界面实现）
 *
 * 约定：
 *   - 所有时间戳统一为「Unix 毫秒」（epoch ms），展示时按 UTC+8 格式化。
 *   - 所有 id 均为字符串；跨平台的复合 id 用 `${a}:${b}` 形式拼接。
 */

/* ==================================================================
 * 1. 平台与账号
 * ================================================================== */

/**
 * 支持的社交平台。
 *
 * 更新需求 §1：取消企业微信（企业办公软件的权限与加密更复杂，暂不接入），
 * 只保留微信与 QQ 两个平台。
 */
export type PlatformId = 'wechat' | 'qq'

/** 平台元信息（界面展示用） */
export interface PlatformDescriptor {
  id: PlatformId
  /** 中文名，如「微信」 */
  label: string
  /** 主题色，用于标签与标签页色点 */
  color: string
  /** 该平台支持的登录方式 */
  loginMethods: LoginMethod[]
  /**
   * 每个平台可登录的账号数上限。
   * 更新需求 §1 明确「账号多开由用户自理，我们不管了」，因此不再限制数量，
   * 这里的值仅作为「不限制」的约定（0 = 不限制），界面不做校验。
   * 字段保留是为了兼容既有数据与契约，不再参与任何逻辑判断。
   */
  maxAccounts: number
  /** 是否已接入真实数据读取（false = 仅界面/占位实现） */
  dataSourceReady: boolean
}

/**
 * 登录方式。
 *
 * 更新需求 §1 取消了所有平台的扫码登录（拿不到各家的私有登录协议），
 * 因此这里只保留：
 *  - local-detect  检测本机已登录账号（微信走 wechat_exp 扫数据目录，QQ 扫本地数据库）
 *  - manual-key    手动登记账号并填写数据库密钥（QQ 用；密钥提取需要注入进程，
 *                  我们自己不做，改为复用 QQFlow 已提取的密钥或让用户粘贴）
 */
export type LoginMethod = 'local-detect' | 'manual-key'

/** 账号登录状态 */
export type AccountState = 'online' | 'offline' | 'expired'

/**
 * 平台登录状态探测结果（第二次更新需求 §3）。
 *
 * 需求：微信/QQ 的密钥提取需要平台处于登录状态、且有「密钥窗口期」，
 * 因此软件要监听登录状态、在检测到登录后触发密钥提取，而不是盲目定时轮询。
 * 这个结构就是监听循环每轮产出的快照。
 */
export interface PlatformLoginState {
  platform: PlatformId
  /** 本机是否检测到该平台客户端进程正在运行（近似"已登录"） */
  running: boolean
  /** 本机是否已有该平台的可用账号/密钥 */
  ready: boolean
  /** 进程名（如 QQ.exe / WeChat.exe），便于排查 */
  processName?: string
  /** 说明文案，可直接展示给用户 */
  message: string
  /** 检查时间（epoch ms） */
  checkedAt: number
}

/** 一个已登记的平台账号 */
export interface Account {
  /** 本应用内部 id（app 生成，稳定不变） */
  id: string
  platform: PlatformId
  /** 平台侧标识：微信 wxid / QQ 号 */
  platformAccountId: string
  /** 展示名（昵称/备注） */
  displayName: string
  /** 头像地址（可能是 data URL 或本地文件路径） */
  avatarUrl?: string
  state: AccountState
  loginMethod: LoginMethod
  /** 是否由本机数据目录自动识别得到（微信走此路径） */
  detectedLocally: boolean
  /** 该账号在 wechat_exp 中的 db_storage 目录（微信专用） */
  dbStorageDir?: string
  createdAt: number
  lastSeenAt: number
  /** 备注，用户可编辑 */
  note?: string
}

/** 登录流程中的会话（扫码等异步登录用） */
export interface LoginSession {
  sessionId: string
  platform: PlatformId
  method: LoginMethod
  /** 二维码内容；界面据此生成二维码图片 */
  qrContent?: string
  /** 二维码图片 data URL（若提供方直接给图） */
  qrImageDataUrl?: string
  /** 轮询/过期时间 */
  expiresAt?: number
  state: 'pending' | 'scanned' | 'confirmed' | 'failed' | 'cancelled'
  message?: string
  /** 登录成功后产出的账号（保留字段：扫码登录已取消，此字段暂不再产生新值） */
  account?: Account
}

/* ==================================================================
 * 1b. QQ 数据源（更新需求 §2.3）
 * ==================================================================
 * 微信那条链路是「启动 wechat_exp 子进程 + HTTP 接口」，QQ 没有这样的工具，
 * 所以这一层是自己实现的：直接定位本机 QQ 的加密数据库、用密钥解密、
 * 再用 sql.js 读表并把消息 BLOB 解析成文本。
 *
 * 密钥来源（我们自己不注入 QQ 进程，那条路在纯 Node 里做不到）：
 *   ① 复用 QQFlow 已经提取好的密钥文件
 *      %APPDATA%\qqflow\qqflow_keys.json
 *      （结构 { "<QQ号>": "<base64(XOR(密钥, "QQFlow2024!@#$%^"))>" }）
 *   ② 用户在界面上手动粘贴 16 字节密钥
 * 两者都写进本应用的加密保险库，之后不用重复输入。
 */

/** 本机发现的一个 QQ 账号数据库 */
export interface QqDatabase {
  /** QQ 号（目录名，纯数字）；全局库为 "global" */
  qq: string
  /** nt_msg.db 的绝对路径 */
  path: string
  /** 文件大小（MB），用于界面展示与"最大的通常是主账号"的判断 */
  sizeMb: number
  /** 文件最后修改时间（epoch ms） */
  modifiedAt?: number
}

/** 某个 QQ 账号的密钥状态 */
export interface QqKeyStatus {
  qq: string
  /** 是否已有可用密钥（本应用保险库里存的，或从 QQFlow 读到的） */
  hasKey: boolean
  /** 密钥来源：本应用手动录入 / 复用 QQFlow / 无 */
  source: 'manual' | 'reused-from-qqflow' | 'none'
  /** QQFlow 的密钥文件路径（供界面提示用户"为什么这里能自动拿到"） */
  qqflowKeyFile?: string
  /** 说明性文案，可直接展示 */
  message: string
}

/* ==================================================================
 * 2. 会话（联系人 / 群聊）
 * ================================================================== */

export type ConversationKind = 'contact' | 'group'

/** 一个可读取的聊天对象 */
export interface Conversation {
  /** `${accountId}:${platformConversationId}` */
  id: string
  accountId: string
  platform: PlatformId
  /** 平台侧会话 id（微信里可能是 wxid / xxx@chatroom） */
  platformConversationId: string
  kind: ConversationKind
  /** 最终展示名（已按 备注 > 昵称 > 别名 > 原生 id 的优先级解析） */
  name: string
  /** 原始备注名 */
  remark?: string
  /** 微信昵称 */
  nickname?: string
  /** 群成员数（仅群聊） */
  memberCount?: number
  /** 最近一条消息时间（用于排序） */
  lastMessageAt?: number
  /** 是否被用户勾选读取 */
  selected: boolean
  /** 该会话已缓存的消息条数 */
  cachedMessageCount?: number
}

/* ==================================================================
 * 3. 消息
 * ================================================================== */

/** 归一化后的消息类型 */
export type MessageKind =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'emoji'
  | 'link'
  | 'quote'
  | 'system'
  | 'mini-program'
  | 'channels'
  | 'other'

/**
 * 消息里的附件（文件或链接）。
 *
 * 更新需求 §2.1：聊天里发的文件、推文、链接的**内部信息**也要被读取，
 * 其中的任务信息（名称、主题、时间等）同样要抽成任务。
 * 抓到的正文我们缓存在这里，一是给 LLM 当上下文，二是让用户在详情页能看到
 * "这条消息里到底有什么"，不必再回头翻原文件。
 */
export interface Attachment {
  /** file = 本地文件；link = 网址 */
  type: 'file' | 'link'
  /** 文件名或网页标题 */
  name: string
  /** 网址（仅 link） */
  url?: string
  /** 本地文件绝对路径（仅 file，可能为空——文件可能已被清理） */
  path?: string
  /** 文件扩展名（小写，不含点），如 docx / pdf */
  ext?: string
  /** 文件大小（字节） */
  size?: number
  /**
   * 从文件或网页里提取出的正文（已截断）。
   * 提取失败时为空——此时只在原文里保留引用，不据此生成任务。
   */
  text?: string
  /** 提取状态，便于界面与日志说明为什么没有内容 */
  status: 'pending' | 'ok' | 'skipped' | 'failed'
  /** skipped / failed 的原因（中文，可直接展示） */
  reason?: string
}

/** 归一化消息（wechat_exp / QQFlow 的原始结构 → 本应用统一结构） */
export interface ChatMessage {
  /** `${conversationId}:${platformMessageId}` */
  id: string
  conversationId: string
  accountId: string
  platformMessageId: string
  /** 发送者平台 id */
  senderId: string
  /** 发送者展示名（已按优先级解析） */
  senderName: string
  /** 是否本人发出 */
  isSelf: boolean
  kind: MessageKind
  /** 该消息的可读文本内容（图片/文件等给出占位描述，供 LLM 理解上下文） */
  text: string
  /** 原始媒体本地路径（图片/文件等，可为空） */
  mediaPath?: string
  /**
   * 该消息携带的文件/链接附件（含抓取到的正文）。
   * 只有真正去读过内容的消息才有这个字段（避免给每条消息都塞空数组）。
   */
  attachments?: Attachment[]
  /** 消息时间（epoch ms） */
  timestamp: number
  /** 原始数据（调试用，异步落库时可按需裁剪） */
  raw?: unknown
}

/* ==================================================================
 * 4. 任务
 * ================================================================== */

/**
 * 任务状态（对应界面左侧类别）
 *  - upcoming  未开始
 *  - ongoing   进行中
 *  - done      已完成（仅人工确认产生）
 *  - expired   已过期
 *  - deleted   已删除（用户主动移入，可恢复；更新需求 §4）
 *
 * 注意：「已删除」是**分类**而不是物理删除。用户点删除 = 移入这个分类，
 * 只有在这个分类里长按并二次确认才真正从数据库移除。
 * 已删除的任务**不参与时间自动分类**（不因超期而变成"已过期"）。
 */
export type TaskStatus = 'upcoming' | 'ongoing' | 'done' | 'expired' | 'deleted'

/**
 * 任务来源（第二次更新需求 §1）。
 *  - auto   由 LLM / 规则从聊天记录中自动抽取而来（来源信息不可编辑）
 *  - manual 用户手动新建的任务（无来源消息，可自由编辑）
 *
 * 界面据此决定：
 *   - 「来源信息」区块是否可编辑（auto 只读、manual 无来源信息）
 *   - 磁贴上的「手动」角标
 */
export type TaskOrigin = 'auto' | 'manual'

/** 任务的发布人记录（同一任务可能被多人在多群发布） */
export interface TaskPublisher {
  /** 发布人显示名（优先姓名/备注） */
  name: string
  accountId: string
  platform: PlatformId
  conversationId: string
  /** 发布时所在群聊/会话名 */
  conversationName: string
  /** 是否本人 */
  isSelf: boolean
  /** 最早发布时间 */
  publishedAt: number
  /** 该发布人对应的原始消息 id */
  messageId?: string
}

/** 任务所需材料 / 链接 */
export interface TaskMaterial {
  name: string
  /**
   * 材料类型：
   *  - form     需填写的表单（含共享表格）
   *  - document 需提交的文档/材料
   *  - link     线上问卷 / 报名链接等
   *  - offline  线下提交（纸质等）
   *  - unknown  无法判定
   */
  kind: 'form' | 'document' | 'link' | 'offline' | 'unknown'
  /** 线上链接（有则可点击，且用对应账号登录后打开） */
  url?: string
  /** 是否必须 */
  required: boolean
  note?: string
}

/** LLM 抽取出的任务原始字段（未合并、未标状态） */
export interface TaskDraft {
  name: string
  topic: string
  type: string
  organizers: string[]
  startAt?: number
  endAt?: number
  materials: TaskMaterial[]
  contactPerson?: string
  /** 任务发布的原文（用于详情页展示） */
  originalText: string
  /** 模型自评的置信度 0~1（可选） */
  confidence?: number
}

/** 落库后的完整任务 */
export interface Task extends TaskDraft {
  id: string
  /**
   * 任务来源（第二次更新需求 §1）。
   * 旧数据迁移后默认 'auto'；用户手动新建的为 'manual'。
   */
  origin: TaskOrigin
  /** 全部发布人（合并去重后） */
  publishers: TaskPublisher[]
  /** 来源消息 id 列表 */
  sourceMessageIds: string[]
  status: TaskStatus
  /** 人工确认过状态时为 true，自动分类不再覆盖 */
  statusLocked: boolean
  /** 是否被用户删除（软删除，便于排查） */
  deleted?: boolean
  /** 磁贴排序（用户拖拽后的顺序） */
  tileOrder: number
  /** 去重指纹，见 task-dedup.ts */
  fingerprint: string
  createdAt: number
  updatedAt: number
  /** 抽取来源信息 */
  llm?: {
    provider: LlmProviderId
    model: string
    extractedAt: number
    batchId?: string
  }
}

/** 磁贴布局（每个类别一套） */
export interface TileLayout {
  taskId: string
  status: TaskStatus
  col: number
  row: number
}

/* ==================================================================
 * 5. LLM 平台
 * ================================================================== */

export type LlmProviderId = 'deepseek' | 'openai' | 'qwen' | 'ernie' | 'gemini' | 'claude'

/** 模型条目（含价格信息，用于自动挑选最便宜的可用模型） */
export interface LlmModelInfo {
  /** 调用时使用的模型 id */
  id: string
  /** 展示名 */
  label: string
  /** 输入价格（元 / 百万 token），用于挑最便宜 */
  inputPricePerM: number
  /** 输出价格（元 / 百万 token） */
  outputPricePerM: number
  /** 是否支持 JSON 结构化输出 */
  supportsJson: boolean
  /** 备注（如「性价比最高」「不适合长文本」） */
  note?: string
}

export interface LlmProviderDescriptor {
  id: LlmProviderId
  label: string
  /** 主题色 */
  color: string
  /** 申请 Key 的页面 */
  consoleUrl: string
  /** Key 格式提示 */
  keyHint: string
  /** Key 的粗略校验正则（可空） */
  keyPattern?: string
  /** 默认（价格最低）模型 */
  defaultModel: string
  /** 全部可选模型，按价格从低到高 */
  models: LlmModelInfo[]
  /** 是否已实现真实调用（false = 占位） */
  implemented: boolean
}

/** 已保存的 Key 记录（apiKey 只在主进程内存中出现） */
export interface LlmKeyRecord {
  provider: LlmProviderId
  /** 脱敏后的 Key，形如 sk-****abcd，仅用于界面展示 */
  maskedKey: string
  /** 当前选用模型 */
  model: string
  /** 最近一次校验时间 */
  verifiedAt: number
  /** 最近一次校验是否通过 */
  ok: boolean
  /** 失败原因 */
  lastError?: string
}

/* ==================================================================
 * 6. 同步（读取聊天记录）
 * ================================================================== */

/** wechat_exp 集成的运行状态 */
export type SyncState = 'idle' | 'scanning' | 'decrypting' | 'reading' | 'error' | 'stopped'

export interface SyncProgress {
  state: SyncState
  /** 0~1，未知时 undefined */
  progress?: number
  /** 阶段文案，直接展示给用户 */
  message: string
  /** 已读取消息条数 */
  messagesRead: number
  /** 当前处理的会话名 */
  currentConversation?: string
  updatedAt: number
}

/** 同步调度配置 */
export interface SyncSettings {
  /** 轮询间隔（毫秒），需求默认 30 秒 */
  intervalMs: number
  /** 是否启用实时（定时）读取 */
  enabled: boolean
  /** 每次读取回溯的天数（0 = 全部） */
  lookbackDays: number
}

/* ==================================================================
 * 7. 设置与运行时信息
 * ================================================================== */

/**
 * 系统托盘与后台运行配置（第二次更新需求 §3）。
 *
 * 需求：软件应能常驻系统托盘，无需每次开启都重新运行 wechat_exp / QQFlow，
 * 在后台持续捕获任务；该功能可在设置里开关。
 */
export interface TraySettings {
  /** 是否启用系统托盘能力（关闭窗口的行为随之变化） */
  enabled: boolean
  /** 点关闭按钮时是否最小化到托盘（false = 直接退出应用） */
  closeToTray: boolean
  /** 后台持续捕获：监听微信/QQ 登录状态，登录后自动触发密钥提取/导入 */
  backgroundCapture: boolean
}

export interface AppSettings {
  /** 界面语言 */
  locale: 'zh-CN' | 'en-US'
  /** 模拟数据模式：不依赖真实微信环境即可演示 UI */
  mockMode: boolean
  /** wechat_exp.exe 路径（留空则自动搜索） */
  wechatExpPath: string
  /** QQFlow.exe 路径（留空则自动搜索）—— 第二次更新需求 §2/§5 */
  qqflowPath: string
  /** 微信 db_storage 目录覆盖（留空则自动检测） */
  dbStorageDir: string
  /** wechat_exp 服务端口（自动选空闲端口时可不填） */
  wechatExpPort: number
  /** 同步配置 */
  sync: SyncSettings
  /** 托盘与后台运行配置（第二次更新需求 §3） */
  tray: TraySettings
  /** 是否开机自启 */
  launchAtLogin: boolean
  /** 日志级别 */
  logLevel: LogLevel
  /** 界面缩放（应对 2560×1600 等高分辨率） */
  uiScale: number
  /** 外部调用超时（毫秒） */
  ioTimeoutMs: number
  /** 当前选中的 LLM 平台（用于任务抽取） */
  activeLlm: LlmProviderId | null
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: LogLevel
  /** 来源模块，如 'wechat-exp' / 'llm' / 'db' */
  scope: string
  message: string
  detail?: unknown
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  /** 是否打包后的版本 */
  packaged: boolean
  /** 日志目录 */
  logDir: string
  /** 数据目录（数据库/密钥等） */
  dataDir: string
}

/* ==================================================================
 * 8. 加密保险库
 * ================================================================== */

/** 保险库（PBKDF2 + AES-256-GCM）状态 */
export interface VaultStatus {
  /** 是否已完成初始化 */
  initialized: boolean
  /** 是否已解锁（解锁后才能读写敏感数据） */
  unlocked: boolean
  /** 是否使用「记住密码」自动解锁 */
  autoUnlock: boolean
  /** 使用的 KDF 说明，用于界面展示 */
  kdf: {
    algorithm: 'PBKDF2-HMAC-SHA512'
    iterations: number
    keyLength: number
    cipher: 'AES-256-GCM'
    saltLength: number
  }
}

/* ==================================================================
 * 9. 统一的调用结果包装
 * ================================================================== */

/**
 * 所有 IPC 调用的统一返回体。
 * 主进程绝不向渲染进程抛裸异常——一律包成 { ok: false, error }，
 * 这样界面永远能拿到可展示的错误信息。
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

export interface AppError {
  /** 机器可读的错误码 */
  code: string
  /** 面向用户的中文提示 */
  message: string
  /** 便于排查的细节 */
  detail?: string
}

/** 任务抽取的批处理结果 */
export interface ExtractionReport {
  batchId: string
  startedAt: number
  finishedAt: number
  /** 参与抽取的会话数 */
  conversationsProcessed: number
  /** 送入模型的消息条数 */
  messagesSent: number
  /** 新建任务数 */
  tasksCreated: number
  /** 合并进已有任务数 */
  tasksMerged: number
  /** 失败批次 */
  failures: { conversationId: string; error: string }[]
}
