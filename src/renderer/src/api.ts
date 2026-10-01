/**
 * 渲染进程 API 封装
 * ------------------------------------------------------------------
 * 把 `window.wxApi.invoke` 的 Result 包装拆掉，让调用方可以直接 try/catch：
 *
 *   try {
 *     const tasks = await api.taskList({ status: 'ongoing' })
 *   } catch (e) {
 *     if (e instanceof ApiError) showToast(e.message)   // e.message 已是中文
 *   }
 */
import type { IpcChannel, IpcEventName, IpcEvents, IpcReq, IpcRes } from '@shared/ipc'
import type { AppError } from '@shared/types'

export class ApiError extends Error {
  readonly code: string
  readonly detail?: string

  constructor(err: AppError) {
    super(err.message)
    this.name = 'ApiError'
    this.code = err.code
    this.detail = err.detail
  }
}

/** 裸调用：失败时抛 ApiError */
export async function call<K extends IpcChannel>(channel: K, payload: IpcReq<K>): Promise<IpcRes<K>> {
  if (!window.wxApi) {
    throw new ApiError({
      code: 'bridge_missing',
      message: '与主进程的通信通道未就绪（预加载脚本可能加载失败），请重启应用',
      detail: 'window.wxApi is undefined'
    })
  }
  const res = await window.wxApi.invoke(channel, payload)
  if (!res.ok) throw new ApiError(res.error)
  return res.data
}

/** 订阅主进程事件 */
export function on<K extends IpcEventName>(
  event: K,
  handler: (payload: IpcEvents[K]) => void
): () => void {
  if (!window.wxApi) return () => undefined
  return window.wxApi.on(event, handler)
}

/**
 * 按域分组的调用快捷方式。
 * 集中在这里的好处：所有通道名只出现一次，改名时不会漏。
 */
export const api = {
  /* 应用与设置 */
  appInfo: () => call('app:info', undefined),
  getSettings: () => call('app:settings:get', undefined),
  patchSettings: (patch: IpcReq<'app:settings:patch'>) => call('app:settings:patch', patch),
  openPath: (path: string) => call('app:openPath', { path }),
  openExternal: (url: string, accountId?: string) => call('app:openExternal', { url, accountId }),

  /* 日志 */
  readLogs: (limit?: number, level?: string) => call('log:read', { limit, level }),
  clearLogs: () => call('log:clear', undefined),

  /* 保险库 */
  vaultStatus: () => call('vault:status', undefined),
  vaultUnlock: (password: string) => call('vault:unlock', { password }),
  vaultLock: () => call('vault:lock', undefined),
  vaultChangePassword: (req: IpcReq<'vault:changePassword'>) => call('vault:changePassword', req),

  /* 平台与账号 */
  platforms: () => call('platform:list', undefined),
  /** 平台登录状态（第二次更新需求 §3）：微信/QQ 是否在运行、是否已有可用密钥 */
  platformLoginState: () => call('platform:loginState', undefined),
  accounts: () => call('account:list', undefined),
  // 说明：account:add（凭扫码会话落库）随扫码登录一起删除。
  // 现在加账号用下面两个：accountDetectLocal（微信）/ accountAddManual（QQ）。
  accountRemove: (accountId: string) => call('account:remove', { accountId }),
  accountUpdate: (accountId: string, patch: IpcReq<'account:update'>['patch']) =>
    call('account:update', { accountId, patch }),
  accountDetectLocal: (platform: IpcReq<'account:detectLocal'>['platform']) =>
    call('account:detectLocal', { platform }),

  /* 登录 */
  // 说明：更新需求 §1 取消了所有平台的扫码登录，所以这里不再有
  // loginStart / loginPoll / loginCancel / loginSimulate 四个方法。
  // 微信走 accountDetectLocal 自动识别，QQ 走 accountAddManual 手动登记。

  /* QQ 数据源（更新需求 §2.3） */
  qqScanDatabases: () => call('qq:scanDatabases', undefined),
  qqKeyStatus: (qq: string) => call('qq:keyStatus', { qq }),
  qqSaveKey: (qq: string, key: string) => call('qq:saveKey', { qq, key }),
  qqImportFromQqflow: (qq: string) => call('qq:importFromQqflow', { qq }),
  /** 探测 QQFlow 是否已就位（第二次更新需求 §2/§5） */
  qqProbeQqflow: () => call('qq:probeQqflow', undefined),
  /** 启动 QQFlow（纯 GUI 程序，无命令行参数，只能起进程） */
  qqLaunchQqflow: () => call('qq:launchQqflow', undefined),
  accountAddManual: (req: IpcReq<'account:addManual'>) => call('account:addManual', req),

  /* 会话 */
  conversations: (req: IpcReq<'conversation:list'>) => call('conversation:list', req),
  refreshConversations: (accountId: string) => call('conversation:refresh', { accountId }),
  setSelection: (conversationIds: string[], selected: boolean) =>
    call('conversation:setSelection', { conversationIds, selected }),
  selectedConversations: (accountId?: string) => call('conversation:selected', { accountId }),

  /* 消息与同步 */
  messages: (req: IpcReq<'chat:messages'>) => call('chat:messages', req),
  messageCount: (conversationId: string) => call('chat:count', { conversationId }),
  syncStatus: () => call('sync:status', undefined),
  syncStart: (force?: boolean) => call('sync:start', { force }),
  syncStop: () => call('sync:stop', undefined),
  syncProbe: () => call('sync:probe', undefined),

  /* LLM */
  llmProviders: () => call('llm:providers', undefined),
  llmKeys: () => call('llm:keys', undefined),
  llmSaveKey: (req: IpcReq<'llm:saveKey'>) => call('llm:saveKey', req),
  llmTestKey: (req: IpcReq<'llm:testKey'>) => call('llm:testKey', req),
  llmRemoveKey: (provider: IpcReq<'llm:removeKey'>['provider']) =>
    call('llm:removeKey', { provider }),
  llmSetActive: (provider: IpcReq<'llm:setActive'>['provider']) =>
    call('llm:setActive', { provider }),

  /* 任务 */
  tasks: (req: IpcReq<'task:list'>) => call('task:list', req),
  taskGet: (taskId: string) => call('task:get', { taskId }),
  /** 手动新建任务（第二次更新需求 §1）：返回空白 manual 任务，随后打开详情面板 */
  taskCreate: () => call('task:create', undefined),
  /** 名称/主题缺失时调用 AI 生成；返回 null 表示未配置 LLM（不算错误） */
  taskSuggestMeta: (req: IpcReq<'task:suggestMeta'>) => call('task:suggestMeta', req),
  taskExtract: (req: IpcReq<'task:extract'>) => call('task:extract', req),
  taskSetStatus: (taskId: string, status: IpcReq<'task:setStatus'>['status']) =>
    call('task:setStatus', { taskId, status }),
  /** 删除 = 移入「已删除」分类（更新需求 §4） */
  taskDelete: (taskId: string) => call('task:delete', { taskId }),
  /** 从「已删除」恢复，按起止时间重新归类 */
  taskRestore: (taskId: string) => call('task:restore', { taskId }),
  /** 彻底删除（仅「已删除」分类里、经二次确认后调用） */
  taskPurge: (taskId: string) => call('task:purge', { taskId }),
  /** 多选批量操作 */
  taskBatch: (taskIds: string[], action: IpcReq<'task:batch'>['action']) =>
    call('task:batch', { taskIds, action }),
  /** 一键清除某个分类的全部任务（不动账号与 API Key） */
  taskClearCategory: (status: IpcReq<'task:clearCategory'>['status'], hardDelete?: boolean) =>
    call('task:clearCategory', { status, hardDelete }),
  taskUpdate: (taskId: string, patch: IpcReq<'task:update'>['patch']) =>
    call('task:update', { taskId, patch }),
  layouts: () => call('task:layout:get', undefined),
  setLayouts: (layouts: IpcReq<'task:layout:set'>['layouts']) =>
    call('task:layout:set', { layouts }),
  reclassify: () => call('task:reclassify', undefined),

  /* 演示数据 */
  mockSeed: (reset?: boolean) => call('mock:seed', { reset }),
  mockClear: () => call('mock:clear', undefined)
}

/* ------------------------------------------------------------------ */
/* 轻量提示总线                                                        */
/* ------------------------------------------------------------------ */

export type ToastKind = 'info' | 'ok' | 'warn' | 'error'

export interface ToastPayload {
  id: number
  kind: ToastKind
  message: string
  detail?: string
}

type ToastListener = (t: ToastPayload) => void
const toastListeners = new Set<ToastListener>()
let toastSeq = 0

export function onToast(fn: ToastListener): () => void {
  toastListeners.add(fn)
  return () => toastListeners.delete(fn)
}

/** 弹一条提示（界面右上角） */
export function toast(kind: ToastKind, message: string, detail?: string): void {
  const payload: ToastPayload = { id: ++toastSeq, kind, message, detail }
  for (const fn of toastListeners) {
    try {
      fn(payload)
    } catch {
      /* 单个订阅者出错不影响其它 */
    }
  }
}

/** 把异常转成用户可读的提示 */
export function toastError(e: unknown, prefix?: string): void {
  if (e instanceof ApiError) {
    toast('error', prefix ? `${prefix}：${e.message}` : e.message, e.detail)
  } else if (e instanceof Error) {
    toast('error', prefix ? `${prefix}：${e.message}` : e.message)
  } else {
    toast('error', prefix ? `${prefix}：${String(e)}` : String(e))
  }
}

/** 包装一次调用：失败自动弹提示并返回 null（适合「点了按钮只关心成没成」的场景） */
export async function tryCall<T>(fn: () => Promise<T>, prefix?: string): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    toastError(e, prefix)
    return null
  }
}
