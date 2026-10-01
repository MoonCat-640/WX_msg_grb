/**
 * IPC 通道契约
 * ------------------------------------------------------------------
 * 渲染进程只能通过这里声明的通道访问主进程能力。
 * 每条通道都写明「请求体」与「返回体」，主进程与渲染进程共用同一份类型，
 * 因此任何改动都会在编译期暴露不一致。
 *
 * 命名规范：`<域>:<动作>`，例如 `task:list`、`llm:testKey`。
 */

import type {
  Account,
  AppInfo,
  AppSettings,
  ChatMessage,
  Conversation,
  ExtractionReport,
  LlmKeyRecord,
  LlmProviderDescriptor,
  LlmProviderId,
  LoginMethod,
  LoginSession,
  LogEntry,
  PlatformDescriptor,
  PlatformId,
  PlatformLoginState,
  QqDatabase,
  QqKeyStatus,
  Result,
  SyncProgress,
  Task,
  TaskStatus,
  TileLayout,
  VaultStatus
} from './types'

/** 二维码登录启动参数（已废弃：更新需求 §1 取消扫码登录，保留类型仅为兼容旧数据） */
export interface LoginStartRequest {
  platform: PlatformId
  method: LoginMethod
  /** 账号密码登录时使用（已废弃） */
  credential?: { account: string; password: string }
}

/** 会话列表查询参数 */
export interface ConversationListRequest {
  accountId: string
  /** 按名称模糊过滤 */
  keyword?: string
  kind?: 'contact' | 'group'
}

/** 消息查询参数 */
export interface MessageQueryRequest {
  conversationId: string
  /** 起始时间（epoch ms），可选 */
  from?: number
  to?: number
  limit?: number
  offset?: number
  keyword?: string
}

/** 任务列表查询参数 */
export interface TaskListRequest {
  status?: TaskStatus
  keyword?: string
  /** 是否包含已删除（排查用） */
  includeDeleted?: boolean
}

/** 数据来源自检结果（界面「环境自检」展示） */
export interface SyncProbeResult {
  exeFound: boolean
  exePath?: string
  exeVersion?: string
  serviceRunning: boolean
  servicePort?: number
  dbStorageDir?: string
  backend: 'wechat-exp-service' | 'wechat-exp-cli' | 'mock' | 'none'
  notes: string[]
}

/** 主进程暴露的全部可调用通道 */
export interface IpcContract {
  /* ---------- 应用与设置 ---------- */
  'app:info': { req: void; res: AppInfo }
  'app:settings:get': { req: void; res: AppSettings }
  'app:settings:patch': { req: Partial<AppSettings>; res: AppSettings }
  'app:openPath': { req: { path: string }; res: void }
  'app:openExternal': { req: { url: string; accountId?: string }; res: void }

  /* ---------- 日志 ---------- */
  'log:read': { req: { limit?: number; level?: string }; res: LogEntry[] }
  'log:clear': { req: void; res: void }

  /* ---------- 加密保险库 ---------- */
  'vault:status': { req: void; res: VaultStatus }
  'vault:unlock': { req: { password: string }; res: VaultStatus }
  'vault:setup': { req: { password: string; autoUnlock: boolean }; res: VaultStatus }
  'vault:lock': { req: void; res: VaultStatus }
  'vault:changePassword': {
    req: { oldPassword: string; newPassword: string; autoUnlock: boolean }
    res: VaultStatus
  }

  /* ---------- 平台与账号 ---------- */
  'platform:list': { req: void; res: PlatformDescriptor[] }
  /**
   * 平台登录状态探测（第二次更新需求 §3）：
   * 返回微信/QQ 客户端是否运行、是否已有可用密钥/账号。设置面板与后台监听都用它。
   */
  'platform:loginState': { req: void; res: PlatformLoginState[] }
  'account:list': { req: void; res: Account[] }
  // 说明：原来的 'account:add'（凭登录会话 sessionId 落库）随扫码登录一起删掉了。
  // 现在加账号只有两条路：account:detectLocal（微信本机识别）与 account:addManual（QQ 手动登记）。
  'account:remove': { req: { accountId: string }; res: void }
  'account:update': { req: { accountId: string; patch: Partial<Account> }; res: Account }
  'account:detectLocal': { req: { platform: PlatformId }; res: Account[] }
  /**
   * 手动登记账号（更新需求 §1：取消扫码登录后，QQ 靠这个入口加账号）。
   * 微信仍优先用 account:detectLocal 自动识别。
   */
  'account:addManual': {
    req: {
      platform: PlatformId
      platformAccountId: string
      displayName?: string
      /** QQ 专用：nt_msg.db 路径 */
      dbPath?: string
      /** QQ 专用：16 字节数据库密钥（不填则尝试复用 QQFlow 已提取的） */
      key?: string
      note?: string
    }
    res: Account
  }

  /* ---------- QQ 数据源（更新需求 §2.3） ---------- */
  /** 扫描本机所有 QQ 账号的 nt_msg.db */
  'qq:scanDatabases': { req: void; res: QqDatabase[] }
  /** 查询某个 QQ 号的密钥状态（含能否从 QQFlow 复用） */
  'qq:keyStatus': { req: { qq: string }; res: QqKeyStatus }
  /** 校验并保存某个 QQ 号的数据库密钥 */
  'qq:saveKey': {
    req: { qq: string; key: string; dbPath?: string }
    res: { ok: boolean; message: string }
  }
  /** 从 QQFlow 的密钥文件里读回某个 QQ 号的密钥（只读不改 QQFlow 的文件） */
  'qq:importFromQqflow': {
    req: { qq: string }
    res: { ok: boolean; message: string; imported: number }
  }
  /**
   * 启动 QQFlow（第二次更新需求 §2/§5）。
   *
   * 重要事实：QQFlow 是**纯 GUI 程序，没有任何命令行参数**（已核对源码 main.rs），
   * 因此"命令行调用 QQFlow"实际只能实现为**启动它的进程**——用户在它自己的窗口里
   * 点「开始提取密钥」，密钥写到 %APPDATA%\qqflow\qqflow_keys.json 后，
   * 再用 qq:importFromQqflow 导回本软件。
   */
  'qq:launchQqflow': { req: void; res: { launched: boolean; path?: string; message: string } }
  /** 探测 QQFlow 是否已就位（界面据此决定是否显示"打开 QQFlow"入口） */
  'qq:probeQqflow': { req: void; res: { found: boolean; path?: string } }

  /* ---------- 会话 ---------- */
  'conversation:list': { req: ConversationListRequest; res: Conversation[] }
  'conversation:refresh': { req: { accountId: string }; res: Conversation[] }
  'conversation:setSelection': {
    req: { conversationIds: string[]; selected: boolean }
    res: Conversation[]
  }
  'conversation:selected': { req: { accountId?: string }; res: Conversation[] }

  /* ---------- 聊天记录读取 ---------- */
  'chat:messages': { req: MessageQueryRequest; res: ChatMessage[] }
  'chat:count': { req: { conversationId: string }; res: number }
  'sync:status': { req: void; res: SyncProgress }
  'sync:start': { req: { force?: boolean }; res: SyncProgress }
  'sync:stop': { req: void; res: SyncProgress }
  'sync:probe': {
    req: void
    res: SyncProbeResult
  }

  /* ---------- LLM ---------- */
  'llm:providers': { req: void; res: LlmProviderDescriptor[] }
  'llm:keys': { req: void; res: LlmKeyRecord[] }
  'llm:saveKey': {
    req: { provider: LlmProviderId; apiKey: string; model?: string }
    res: { record: LlmKeyRecord; testOk: boolean; testMessage: string }
  }
  'llm:testKey': {
    req: { provider: LlmProviderId; apiKey?: string; model?: string }
    res: { ok: boolean; message: string; model?: string; latencyMs?: number }
  }
  'llm:removeKey': { req: { provider: LlmProviderId }; res: LlmKeyRecord[] }
  'llm:setActive': { req: { provider: LlmProviderId | null }; res: LlmKeyRecord[] }

  /* ---------- 任务 ---------- */
  'task:list': { req: TaskListRequest; res: Task[] }
  'task:get': { req: { taskId: string }; res: Task | null }
  /**
   * 手动新建任务（第二次更新需求 §1）：建一条空白 manual 任务并返回，
   * 界面随即打开任务详情面板供用户填写（相关信息填写后自动保存）。
   */
  'task:create': { req: void; res: Task }
  /**
   * 名称/主题缺失时调用 AI 生成（第二次更新需求 §1）。
   * 返回 null 表示未配置 LLM 或调用失败——属"可接受"，不算错误，界面保持原样即可。
   */
  'task:suggestMeta': {
    req: {
      name?: string
      topic?: string
      type?: string
      organizers?: string[]
      contactPerson?: string
      timeText?: string
    }
    res: { name: string; topic: string; model?: string } | null
  }
  'task:extract': { req: { conversationIds?: string[]; full?: boolean }; res: ExtractionReport }
  'task:setStatus': { req: { taskId: string; status: TaskStatus }; res: Task }
  /**
   * 删除任务 = **移入「已删除」分类**（更新需求 §4）。
   * 不再物理删除；要彻底删除请用 task:purge（在「已删除」分类里长按触发）。
   */
  'task:delete': { req: { taskId: string }; res: Task }
  /** 从「已删除」恢复：按起止时间重新归类（不直接扔回"进行中"） */
  'task:restore': { req: { taskId: string }; res: Task }
  /** 彻底删除（连数据库记录一起删）——仅在「已删除」分类里可调用 */
  'task:purge': { req: { taskId: string }; res: void }
  /**
   * 批量操作（更新需求 §3 的多选模式）。
   * action=delete → 批量移入「已删除」；action=restore → 批量恢复；
   * action=purge → 批量彻底删除（仅限已删除分类）。
   */
  'task:batch': {
    req: { taskIds: string[]; action: 'delete' | 'restore' | 'purge' }
    res: { affected: number; tasks: Task[] }
  }
  /**
   * 一键清除某个分类下的全部任务（更新需求 §3）。
   * 只是把该分类清空，**绝不动账号信息与 API Key**。
   * scope='deleted' 时走彻底删除，其余分类是移入「已删除」。
   */
  'task:clearCategory': {
    req: { status: TaskStatus; hardDelete?: boolean }
    res: { affected: number }
  }
  'task:update': { req: { taskId: string; patch: Partial<Task> }; res: Task }
  'task:layout:get': { req: void; res: TileLayout[] }
  'task:layout:set': { req: { layouts: TileLayout[] }; res: TileLayout[] }
  'task:reclassify': { req: void; res: { changed: number } }

  /* ---------- 演示数据 ---------- */
  'mock:seed': { req: { reset?: boolean }; res: { tasks: number; conversations: number } }
  'mock:clear': { req: void; res: void }
}

/** 主进程主动推送给渲染进程的事件 */
export interface IpcEvents {
  /** 日志流 */
  log: LogEntry
  /** 同步进度 */
  'sync:progress': SyncProgress
  /** 任务集合发生变化（新增/合并/状态变化） */
  'tasks:changed': { reason: string; count: number }
  /** 账号集合变化 */
  'accounts:changed': Account[]
  /** 登录会话状态变化 */
  'login:update': LoginSession
}

export type IpcChannel = keyof IpcContract
export type IpcEventName = keyof IpcEvents
export type IpcReq<K extends IpcChannel> = IpcContract[K]['req']
export type IpcRes<K extends IpcChannel> = IpcContract[K]['res']
export type IpcResult<K extends IpcChannel> = Result<IpcRes<K>>
