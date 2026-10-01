/**
 * IPC 路由
 * ------------------------------------------------------------------
 * 渲染进程只能通过这里访问主进程能力。
 *
 * 两条铁律：
 *   1. **永远不抛裸异常**：所有 handler 的异常都转成 `{ ok:false, error }`，
 *      界面因此总能拿到可展示的中文提示，不会出现白屏或未捕获的 Promise。
 *   2. **敏感数据不出主进程**：LLM 明文 Key 只在主进程内部使用，
 *      对外只返回打码后的 `maskedKey`。
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { IpcChannel, IpcEventName, IpcEvents, IpcReq, IpcRes } from '@shared/ipc'
import type { Account, Task, TaskStatus } from '@shared/types'
import { fail, ok } from './errors'
import { clearLogs, readLogs, scoped } from './logger'
import { getAppPaths } from './paths'
import { getSettings, patchSettings } from './settings'
import { requireReady, unlockAndOpen } from './bootstrap'
import { closeStore, persistNow } from './store'
import {
  changePassword as vaultChangePassword,
  getVaultStatus,
  lockVault,
  setupVault
} from './vault'
import { openExternalWithAccount } from './external-window'
import { listConversations, setSelection } from '../data/conversation-repo'
import { listMessages, countMessages } from '../data/message-repo'
import {
  countByStatus,
  getTask,
  hardDeleteTask,
  listTasks,
  patchTask,
  restoreTask,
  softDeleteTask,
  batchSoftDelete,
  batchHardDelete,
  clearCategory,
  updateStatus
} from '../data/task-repo'
import { getLayouts, setLayouts } from '../data/layout-repo'
import { listKeyRecords, removeKey, saveKey } from '../data/llm-repo'
import { PROVIDERS, PROVIDER_LIST, maskKey, testKey as testLlmKey } from '../llm'
import {
  addManualAccount,
  getPlatform,
  listAllAccounts,
  listPlatforms,
  removeAccount,
  updateAccount
} from '../services/platform-service'
import {
  detectLocalAccounts,
  disposeSync,
  getSyncStatus,
  probe as probeSync,
  refreshConversations,
  runOnce,
  setProgressListener,
  startLoop,
  stopLoop
} from '../services/sync-service'
import { extractTasks } from '../tasks/extractor'
// 手动任务（第二次更新需求 §1）：新建空白任务 + AI 生成名称/主题
import { createManualTask, suggestMeta } from '../tasks/manual'
// 平台登录状态（第二次更新需求 §3）
import { getPlatformLoginStates, startLoginWatch, stopLoginWatch } from '../services/login-watch'
// 系统托盘（第二次更新需求 §3）：设置变更后即时创建/销毁
import { applyTraySettings } from './tray'
import { reclassifyAll } from '../tasks/status'
import { kvSet } from '../data/kv-repo'

const log = scoped('ipc')

/**
 * 自动抽取任务（origin='auto'）**不允许用户修改**的来源字段。
 * 依据：第二次更新需求 §1b「对于 AI 抓取到的任务，用户不能修改信息来源」。
 * 手动任务（origin='manual'）没有这些来源信息，不参与限制。
 */
const SOURCE_LOCKED_FIELDS = [
  'publishers',
  'sourceMessageIds',
  'originalText',
  'llm',
  'fingerprint',
  'origin'
] as const

/* ------------------------------------------------------------------ */
/* 事件推送                                                            */
/* ------------------------------------------------------------------ */

/** 向所有窗口广播事件 */
function emit<K extends IpcEventName>(event: K, payload: IpcEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}

/** 业务数据变了就通知界面刷新（任务/账号） */
function notifyTasksChanged(reason: string): void {
  emit('tasks:changed', { reason, count: listTasks({}).length })
}

function notifyAccountsChanged(): void {
  emit('accounts:changed', listAllAccounts())
}

/* ------------------------------------------------------------------ */
/* 注册器                                                              */
/* ------------------------------------------------------------------ */

type Handler<K extends IpcChannel> = (payload: IpcReq<K>) => Promise<IpcRes<K>> | IpcRes<K>

/**
 * 注册一个通道。统一做三件事：就绪性检查、异常包装、耗时日志。
 * `needsStore` 为 true 时，会先确认保险库已解锁且数据库已打开。
 */
function handle<K extends IpcChannel>(
  channel: K,
  handler: Handler<K>,
  opts: { needsStore?: boolean } = {}
): void {
  ipcMain.handle(channel, async (_evt, payload: IpcReq<K>) => {
    const started = Date.now()
    try {
      if (opts.needsStore) requireReady()
      const data = await handler(payload)
      const cost = Date.now() - started
      // 只记慢调用与关键通道，避免日志被高频轮询刷屏
      if (cost > 300) log.debug(`IPC ${channel} 完成`, { 耗时ms: cost })
      return ok(data)
    } catch (e) {
      log.error(`IPC ${channel} 失败`, {
        请求: payload === undefined ? '' : JSON.stringify(payload).slice(0, 300),
        错误: e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      })
      return fail(e)
    }
  })
}

/* ------------------------------------------------------------------ */
/* 注册全部通道                                                        */
/* ------------------------------------------------------------------ */

export function registerIpcHandlers(): void {
  /* ---------- 应用与设置 ---------- */

  handle('app:info', () => ({
    name: '微信消息任务汇总器',
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? '',
    platform: process.platform,
    packaged: app.isPackaged,
    logDir: getAppPaths().logDir,
    dataDir: getAppPaths().dataDir
  }))

  handle('app:settings:get', () => getSettings())

  handle('app:settings:patch', (patch) => {
    const before = getSettings()
    const next = patchSettings(patch)
    // 同步间隔改了要重启循环才生效
    if (patch.sync && before.sync.intervalMs !== next.sync.intervalMs) {
      log.info('同步间隔已变更，将在下一轮生效', { 新间隔ms: next.sync.intervalMs })
    }

    // 托盘与后台捕获（第二次更新需求 §3）：改设置即时生效，不必重启软件
    if (patch.tray) {
      applyTraySettings(next)
      if (next.tray.backgroundCapture) {
        startLoginWatch()
      } else {
        stopLoginWatch()
      }
      log.info('托盘/后台捕获设置已生效', {
        托盘: next.tray.enabled,
        关闭到托盘: next.tray.closeToTray,
        后台捕获: next.tray.backgroundCapture
      })
    }

    return next
  })

  handle('app:openPath', async ({ path }) => {
    await shell.openPath(path)
  })

  handle('app:openExternal', async ({ url, accountId }) => {
    await openExternalWithAccount(url, accountId)
  })

  /* ---------- 日志 ---------- */

  handle('log:read', ({ limit, level }) => readLogs(limit ?? 500, level))
  handle('log:clear', () => clearLogs())

  /* ---------- 保险库 ---------- */

  handle('vault:status', () => getVaultStatus())

  handle('vault:unlock', async ({ password }) => {
    const status = await unlockAndOpen(password)
    log.info('用户手动解锁成功')
    return status
  })

  handle('vault:setup', ({ password, autoUnlock }) => setupVault(password, autoUnlock))

  handle('vault:lock', async () => {
    stopLoop()
    await persistNow()
    await closeStore()
    return lockVault()
  })

  handle('vault:changePassword', ({ oldPassword, newPassword, autoUnlock }) =>
    vaultChangePassword(oldPassword, newPassword, autoUnlock)
  )

  /* ---------- 平台与账号 ---------- */

  handle('platform:list', () => listPlatforms())

  handle('account:list', () => listAllAccounts(), { needsStore: true })

  handle('account:remove', async ({ accountId }) => {
    removeAccount(accountId)
    notifyAccountsChanged()
    notifyTasksChanged('账号移除')
  }, { needsStore: true })

  handle('account:update', ({ accountId, patch }) => {
    const account = updateAccount(accountId, patch)
    notifyAccountsChanged()
    return account
  }, { needsStore: true })

  handle('account:detectLocal', async ({ platform }) => {
    const found = await detectLocalAccounts(platform)
    // 落库（已存在的跳过）
    const { findAccount, insertAccount } = await import('../data/account-repo')
    for (const acc of found) {
      if (!findAccount(acc.platform, acc.platformAccountId)) {
        insertAccount(acc)
      }
    }
    notifyAccountsChanged()
    return listAllAccounts()
  })

  /**
   * 手动登记账号（更新需求 §1：取消扫码登录后，QQ 靠这个入口加账号）。
   * 若带了密钥，顺手存进 QQ 密钥库（加密），省得用户再填一次。
   */
  handle('account:addManual', async (params) => {
    const account = addManualAccount(params)
    if (params.platform === 'qq' && params.key) {
      const { saveQqKey } = await import('../qq')
      saveQqKey(account.platformAccountId, params.key)
    }
    notifyAccountsChanged()
    return account
  }, { needsStore: true })

  /* ---------- QQ 数据源（更新需求 §2.3） ---------- */
  // 说明：这里统一用动态 import('../qq')。QQ 模块会读文件、跑解密，
  // 属于"重"依赖；动态引入可以避免它拖慢应用启动，也让这一层与 QQ 实现的
  // 具体形态解耦（日后换成别的读取方式，只要导出同名函数即可）。

  handle('qq:scanDatabases', async () => {
    const { scanQqDatabases } = await import('../qq')
    return scanQqDatabases()
  })

  handle('qq:keyStatus', async ({ qq }) => {
    const q = await import('../qq')
    const own = q.getQqKey(qq)
    const qqflow = q.readQqflowKeys()
    // 三态：本软件里存过 > 能从 QQFlow 复用 > 都没有
    if (own) {
      return { qq, hasKey: true, source: 'manual' as const, qqflowKeyFile: q.qqflowKeyFilePath(), message: '已在本软件中保存该账号的密钥' }
    }
    if (qqflow[qq]) {
      return { qq, hasKey: true, source: 'reused-from-qqflow' as const, qqflowKeyFile: q.qqflowKeyFilePath(), message: '可从 QQFlow 的密钥文件复用（点「导入」即存到本软件）' }
    }
    return { qq, hasKey: false, source: 'none' as const, qqflowKeyFile: q.qqflowKeyFilePath(), message: '尚未保存密钥，请粘贴 16 位密钥' }
  }, { needsStore: true })

  handle('qq:saveKey', async ({ qq, key }) => {
    const q = await import('../qq')
    const check = q.validateQqKey(key)
    if (!check.ok) return { ok: false, message: check.message }
    q.saveQqKey(qq, key)
    log.info('已保存 QQ 数据库密钥', { qq })
    return { ok: true, message: '密钥已保存并加密存储' }
  }, { needsStore: true })

  handle('qq:importFromQqflow', async ({ qq }) => {
    const q = await import('../qq')
    const imported = q.importKeysFromQqflow(qq)
    return {
      ok: imported > 0,
      imported,
      message:
        imported > 0
          ? `已从 QQFlow 导入 ${imported} 个账号的密钥`
          : '未在 QQFlow 的密钥文件里找到可用密钥（可能你还没用它提取过）'
    }
  }, { needsStore: true })

  /* ---------- 会话 ---------- */

  handle('conversation:list', ({ accountId, keyword, kind }) =>
    listConversations({ accountId, keyword, kind }),
    { needsStore: true }
  )

  handle('conversation:refresh', ({ accountId }) => refreshConversations(accountId), {
    needsStore: true
  })

  handle('conversation:setSelection', ({ conversationIds, selected }) => {
    setSelection(conversationIds, selected)
    return listConversations({})
  }, { needsStore: true })

  handle('conversation:selected', ({ accountId }) =>
    listConversations({ accountId, onlySelected: true }),
    { needsStore: true }
  )

  /* ---------- 聊天记录 ---------- */

  handle('chat:messages', ({ conversationId, from, to, limit, offset, keyword }) =>
    listMessages({ conversationId, from, to, limit, offset, keyword }),
    { needsStore: true }
  )

  handle('chat:count', ({ conversationId }) => countMessages(conversationId), { needsStore: true })

  handle('sync:status', () => getSyncStatus())

  handle('sync:start', async ({ force }) => {
    const result = await startLoop({ force })
    notifyTasksChanged('同步启动')
    return result
  }, { needsStore: true })

  handle('sync:stop', () => stopLoop())

  handle('sync:probe', () => probeSync())

  /* ---------- LLM ---------- */

  handle('llm:providers', () => PROVIDER_LIST)

  handle('llm:keys', () => listKeyRecords(), { needsStore: true })

  handle('llm:testKey', async ({ provider, apiKey, model }) => {
    // 未传 Key 时用已保存的（此时 Key 不会离开主进程）
    let key = apiKey
    if (!key) {
      const { getPlainKey } = await import('../data/llm-repo')
      key = getPlainKey(provider) ?? undefined
    }
    if (!key) {
      return { ok: false, message: '尚未填写 API Key' }
    }
    const result = await testLlmKey(provider, key, model)
    return {
      ok: result.ok,
      message: result.message,
      model: result.model,
      latencyMs: result.latencyMs
    }
  }, { needsStore: true })

  handle('llm:saveKey', async ({ provider, apiKey, model }) => {
    const descriptor = PROVIDERS[provider]
    if (!descriptor) throw new Error(`未知的 LLM 平台: ${provider}`)
    const useModel = model || descriptor.defaultModel

    // 先校验再保存：需求要求「自动检测 API Key 是否可用」
    const test = await testLlmKey(provider, apiKey, useModel)
    const record = saveKey({
      provider,
      apiKey,
      maskedKey: maskKey(apiKey),
      model: useModel,
      ok: test.ok,
      lastError: test.ok ? undefined : test.message
    })

    // 校验通过则自动设为当前使用的平台（用户少点一次）
    if (test.ok) {
      patchSettings({ activeLlm: provider })
    }
    log.info('LLM Key 保存', { provider, 校验通过: test.ok, 模型: useModel })
    return { record, testOk: test.ok, testMessage: test.message }
  }, { needsStore: true })

  handle('llm:removeKey', ({ provider }) => {
    removeKey(provider)
    const settings = getSettings()
    if (settings.activeLlm === provider) {
      patchSettings({ activeLlm: null })
    }
    return listKeyRecords()
  }, { needsStore: true })

  handle('llm:setActive', ({ provider }) => {
    patchSettings({ activeLlm: provider })
    return listKeyRecords()
  }, { needsStore: true })

  /* ---------- 任务 ---------- */

  handle('task:list', ({ status, keyword, includeDeleted }) => {
    // 展示前先按当前时间刷新一遍状态，保证「实时」感
    reclassifyAll()
    return listTasks({ status, keyword, includeDeleted })
  }, { needsStore: true })

  handle('task:get', ({ taskId }) => getTask(taskId), { needsStore: true })

  handle('task:extract', async ({ conversationIds, full }) => {
    const report = await extractTasks({ conversationIds, full })
    notifyTasksChanged('手动抽取')
    return report
  }, { needsStore: true })

  handle('task:setStatus', ({ taskId, status }) => {
    // 「已删除」不走这条通道的正常语义：它要同时置 deleted 标志、清磁贴布局，
    // 交给 deleteTask 处理（否则任务会同时出现在"已删除"和原来那个分类里）。
    if (status === 'deleted') {
      const task = getTask(taskId)
      if (!task) throw new Error('任务不存在')
      softDeleteTask(taskId)
      notifyTasksChanged('移入已删除')
      return getTask(taskId)!
    }
    // 人工确认 → 锁定状态，自动分类不再覆盖（原版需求「人工确认」）
    const task = patchTask(taskId, { status, statusLocked: status === 'done' })
    if (!task) throw new Error('任务不存在')
    log.info('任务状态被人工修改', { 任务: task.name, 新状态: status })
    notifyTasksChanged('状态变更')
    return task
  }, { needsStore: true })

  /**
   * 删除任务 = **移入「已删除」分类**（更新需求 §4）。
   * 不再物理删除——用户点删除多数只是"这事不该我做"，留个后悔药。
   */
  handle('task:delete', ({ taskId }) => {
    softDeleteTask(taskId)
    const task = getTask(taskId)
    if (!task) throw new Error('任务不存在')
    notifyTasksChanged('移入已删除')
    return task
  }, { needsStore: true })

  /** 从「已删除」恢复，按起止时间重新归类（更新需求 §4 边界） */
  handle('task:restore', ({ taskId }) => {
    const task = restoreTask(taskId)
    if (!task) throw new Error('任务不存在')
    notifyTasksChanged('任务恢复')
    return task
  }, { needsStore: true })

  /** 彻底删除——只在「已删除」分类里、经过二次确认后调用 */
  handle('task:purge', ({ taskId }) => {
    hardDeleteTask(taskId)
    notifyTasksChanged('彻底删除')
  }, { needsStore: true })

  /** 批量操作（更新需求 §3 的多选模式） */
  handle('task:batch', ({ taskIds, action }) => {
    let affected = 0
    if (action === 'delete') affected = batchSoftDelete(taskIds)
    else if (action === 'purge') affected = batchHardDelete(taskIds)
    else {
      // 批量恢复：逐个按起止时间重算分类（不能简单置回 ongoing）
      for (const id of taskIds) {
        if (restoreTask(id)) affected++
      }
    }
    log.info('批量任务操作', { 动作: action, 数量: affected })
    notifyTasksChanged(`批量${action}`)
    return { affected, tasks: listTasks({}) }
  }, { needsStore: true })

  /**
   * 一键清除某个分类下的全部任务（更新需求 §3）。
   * 只动 tasks 表——账号信息、API Key、其它分类都不受影响。
   */
  handle('task:clearCategory', ({ status, hardDelete }) => {
    const affected = clearCategory(status, Boolean(hardDelete))
    log.warn('一键清除分类', { 分类: status, 数量: affected, 彻底删除: Boolean(hardDelete) })
    notifyTasksChanged('一键清除')
    return { affected }
  }, { needsStore: true })

  /**
   * 任务字段更新（第二次更新需求 §1b：用户可自由编辑任务）。
   *
   * 边界：需求明确「对于 AI 抓取到的任务，用户不能修改信息来源」，
   * 因此对 origin='auto' 的任务，**来源相关字段一律忽略**（即使界面误传也不生效）：
   *   publishers / sourceMessageIds / originalText / llm / fingerprint / origin
   * 其它字段（名称、主题、类型、负责人、接头人、起止时间、材料、状态）允许自由修改。
   */
  handle('task:update', ({ taskId, patch }) => {
    const current = getTask(taskId)
    if (!current) throw new Error('任务不存在')

    const safePatch: Partial<Task> = { ...patch }
    if (current.origin !== 'manual') {
      for (const field of SOURCE_LOCKED_FIELDS) {
        delete (safePatch as Record<string, unknown>)[field]
      }
    }

    const task = patchTask(taskId, safePatch)
    if (!task) throw new Error('任务不存在')
    log.info('任务已修改', {
      任务: taskId,
      来源: task.origin,
      字段: Object.keys(safePatch).join(',')
    })
    notifyTasksChanged('任务修改')
    return task
  }, { needsStore: true })

  /* ---------- 手动任务（第二次更新需求 §1） ---------- */

  /** 新建一条空白的手动任务；界面拿到后立即打开详情面板让用户填写 */
  handle('task:create', () => {
    const task = createManualTask()
    notifyTasksChanged('新建手动任务')
    return task
  }, { needsStore: true })

  /**
   * 名称/主题缺失时调用 AI 生成（第二次更新需求 §1a）。
   * 未配置 LLM 时返回 null（不是错误），界面保持原样即可。
   */
  handle('task:suggestMeta', async (input) => {
    const result = await suggestMeta(input)
    if (result) {
      log.info('AI 生成任务名称/主题成功', { name: result.name, model: result.model })
    }
    return result
  }, { needsStore: true })

  /* ---------- 平台登录状态（第二次更新需求 §3） ---------- */
  handle('platform:loginState', () => getPlatformLoginStates())

  /* ---------- QQFlow 外部依赖（第二次更新需求 §2/§5） ---------- */

  /** 探测 QQFlow 是否已就位（界面据此显示/隐藏"打开 QQFlow"入口） */
  handle('qq:probeQqflow', async () => {
    const q = await import('../qq')
    return q.probeQqflow()
  })

  /**
   * 启动 QQFlow（纯 GUI，无命令行参数，只能起进程）。
   * 用户在其窗口里提取密钥后，密钥落到 %APPDATA%\qqflow\qqflow_keys.json，
   * 再由 qq:importFromQqflow 导入本软件。
   */
  handle('qq:launchQqflow', async () => {
    const q = await import('../qq')
    const result = q.launchQqflow()
    log.info('启动 QQFlow 结果', { 启动: result.launched, 路径: result.path })
    return result
  })

  handle('task:layout:get', () => getLayouts(), { needsStore: true })

  handle('task:layout:set', ({ layouts }) => setLayouts(layouts), { needsStore: true })

  handle('task:reclassify', () => {
    const res = reclassifyAll()
    if (res.changed > 0) notifyTasksChanged('自动分类')
    return { changed: res.changed }
  }, { needsStore: true })

  /* ---------- 演示数据 ---------- */

  handle('mock:seed', async ({ reset }) => {
    const settings = patchSettings({ mockMode: true })
    log.info('切换到模拟数据模式', { 重置: Boolean(reset) })

    if (reset) {
      const { clearAllTasks } = await import('../data/task-repo')
      const { clearAllMessages } = await import('../data/message-repo')
      const { listAccounts: la, deleteAccount: da } = await import('../data/account-repo')
      for (const a of la()) da(a.id)
      clearAllTasks()
      clearAllMessages()
      kvSet('mock.seeded', false)
    }

    // 创建演示账号 + 会话 + 消息
    const { seedDemoData } = await import('../services/demo-data')
    const seeded = await seedDemoData()

    // 用规则抽取跑一遍，保证没有 API Key 也能看到任务
    const report = await extractTasks({ useHeuristic: true, full: true })
    reclassifyAll()

    notifyAccountsChanged()
    notifyTasksChanged('演示数据')

    log.info('演示数据准备完成', {
      会话: seeded.conversations,
      消息: seeded.messages,
      任务: report.tasksCreated
    })
    return { tasks: report.tasksCreated, conversations: seeded.conversations }
  }, { needsStore: true })

  handle('mock:clear', async () => {
    const { clearAllTasks } = await import('../data/task-repo')
    const { clearAllMessages } = await import('../data/message-repo')
    const { listAccounts: la, deleteAccount: da } = await import('../data/account-repo')
    const { clearLayouts } = await import('../data/layout-repo')
    for (const a of la()) da(a.id)
    clearAllTasks()
    clearAllMessages()
    clearLayouts()
    kvSet('mock.seeded', false)
    notifyAccountsChanged()
    notifyTasksChanged('清空数据')
    log.warn('已清空全部演示数据')
  }, { needsStore: true })

  /* ---------- 同步进度推送 ---------- */
  setProgressListener((p) => emit('sync:progress', p))

  log.info('IPC 通道注册完成')
}

/** 应用退出前清理 */
export async function disposeIpc(): Promise<void> {
  await disposeSync()
}

export type { Task, TaskStatus, Account }
