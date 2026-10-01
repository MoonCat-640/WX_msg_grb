/**
 * 功能组件契约
 * ------------------------------------------------------------------
 * 这里集中声明「业务组件」的 props 类型。
 *
 * 为什么单独一个文件：界面被拆成多个模块并行开发，先把接口钉死，
 * 各模块之间才不会因为 props 名字/形状不一致而集成失败。
 * 任何一方要改接口，都必须先改这里。
 */
import type { SyncProbeResult } from '@shared/ipc'
import type {
  Account,
  AppSettings,
  Conversation,
  PlatformDescriptor,
  PlatformId,
  Task,
  VaultStatus
} from '@shared/types'

/** 登录向导（需求「模块 2：多平台登录」） */
export interface LoginWizardProps {
  open: boolean
  /** 关闭向导（不退出应用） */
  onClose: () => void
  /** 账号集合变化后通知外壳刷新 */
  onAccountsChanged: () => void
  /** 点「完成」：进入下一步（选择联系人与群聊） */
  onFinish: () => void
  /**
   * 点「取消」。
   * 需求要求「在登录的任意过程点击取消按钮取消登录，退出该软件」。
   * 首次配置流程中传入退出应用的实现；已进入主界面后再打开时传入「仅关闭」。
   */
  onCancel: () => void
  /** 是否为首次配置流程（影响按钮文案与提示语气） */
  firstRun?: boolean
}

/** 账户管理（需求 UI 第 4 点：单击右上角账户按钮进入账户管理） */
export interface AccountManagerProps {
  open: boolean
  onClose: () => void
  accounts: Account[]
  platforms: PlatformDescriptor[]
  /** 账号发生增删改后通知外壳刷新 */
  onChanged: () => void
  /** 打开登录向导添加账号 */
  onAddAccount: () => void
}

/** 右上角账户按钮 + 悬停浮框 */
export interface AccountButtonProps {
  accounts: Account[]
  platforms: PlatformDescriptor[]
  /** 单击进入账户管理 */
  onClick: () => void
}

/** LLM API Key 配置（需求「模块 5」） */
export interface LlmKeyDialogProps {
  open: boolean
  onClose: () => void
  /** Key 保存/切换后通知外壳刷新（外壳据此更新 activeLlm） */
  onChanged: () => void
  /** 首次配置流程：显示「稍后再说」而非「取消」 */
  firstRun?: boolean
}

/** 联系人与群聊选择（需求「模块 3」） */
export interface ConversationPickerProps {
  open: boolean
  onClose: () => void
  accounts: Account[]
  /** 点「确认」后回调 */
  onConfirmed: (selected: Conversation[]) => void
  /** 首次配置流程 */
  firstRun?: boolean
}

/** 任务详情（需求「软件功能 第 7 点」） */
export interface TaskDetailProps {
  open: boolean
  task: Task | null
  onClose: () => void
  /** 全部账号，用于「用获取该任务的账号打开链接」 */
  accounts: Account[]
  /** 任务被修改（状态/字段）后通知外壳刷新磁贴 */
  onChanged: () => void
}

/** 设置面板 */
export interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  settings: AppSettings
  onSettingsChanged: (next: AppSettings) => void
  vault: VaultStatus
  onVaultChanged: (next: VaultStatus) => void
  /** 数据来源自检结果（可为空，为空时面板自己拉一次） */
  probe: SyncProbeResult | null
  /** 请求外壳重新自检 */
  onProbeRefresh: () => void
}

/** 日志面板（便于调试） */
export interface LogPanelProps {
  open: boolean
  onClose: () => void
}

/** 磁贴点击后由外壳决定是「进入详情」还是「拖拽」 */
export interface TaskTileActions {
  onOpen: (task: Task) => void
  /** 长按完成 */
  onComplete: (task: Task) => void
  /** 长按删除 */
  onDelete: (task: Task) => void
}

/** 平台图标/名称映射所需的元信息查询 */
export type PlatformLookup = (id: PlatformId) => PlatformDescriptor | undefined
