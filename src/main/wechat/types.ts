/**
 * wechat_exp 适配层 —— 本层自用类型
 * ------------------------------------------------------------------
 * 这一层是「第三方程序 sunhanaix/pc_wechat_exp」与「本项目领域模型」之间的
 * 防腐层（anti-corruption layer）。上游是 PyInstaller 打包的第三方程序，
 * 其字段随时可能增删，因此这里的 Raw* 类型一律 **全部可选**：
 * 读取时必须走防御性取值，缺字段给默认值并记 warn，绝不能因为上游少给一个
 * 字段就让整条链路崩掉。
 *
 * 注意：本项目领域模型（Conversation / ChatMessage …）定义在 @shared/types，
 * 本文件只描述「上游原样 JSON」与「本层内部传递的结构」。
 */

import type { IpcContract } from '@shared/ipc'

/* ==================================================================
 * 1. 服务健康与后端选择
 * ================================================================== */

/** wechat_exp `serve` 子进程的运行状态 */
export interface WechatExpHealth {
  running: boolean
  /** 监听端口（未运行时为 0） */
  port: number
  /** 形如 http://127.0.0.1:18700，未运行时为空串 */
  baseUrl: string
  /** 从 `--version` 解析出的版本号，如 2.10.20260925 */
  version?: string
  /** 子进程 PID */
  pid?: number
}

/**
 * 当前生效的数据后端：
 *  - mock    ：模拟数据（设置里 mockMode=true，无需真实微信环境）
 *  - service ：真实 wechat_exp serve 服务
 *  - none    ：两者都没有（没装/没启动 exe）
 */
export type WechatExpBackend = 'mock' | 'service' | 'none'

/** exe 定位结果。source=missing 时 path 为空串 */
export interface LocateResult {
  path: string
  source: 'settings' | 'auto' | 'missing'
}

/* ==================================================================
 * 2. 上游 SSE 事件
 * ================================================================== */

/** 上游 SSE 事件名（见契约文档 §B.4，逐字） */
export type SseEventName = 'progress' | 'done' | 'error' | 'select' | 'heartbeat'

/**
 * 已解析的一条 SSE 事件。
 * data 是 `data:` 行 JSON 解析后的对象；解析失败的事件不会出现在这里。
 */
export interface SseEvent {
  event: SseEventName
  data: any
  id?: number
}

/** SSE progress 事件的 data 形状 */
export interface SseProgressData {
  stage?: string
  detail?: string
  progress?: number
  result?: unknown
}

/* ==================================================================
 * 3. 上游原始数据：联系人 / 通讯录 / 账号
 * ================================================================== */

/**
 * 联系人/会话条目。
 * 同时覆盖两个端点的字段：
 *  - GET /api/contacts        （轻量：id/name/type/last_msg_time/msg_count/avatar_url）
 *  - GET /api/address-book    （完整：wxid/display_name/remark/nick_name/alias/…）
 * 哪些字段存在取决于调的是哪个端点，故全部可选。
 */
export interface RawContact {
  /** /api/contacts 用 id；/api/address-book 用 wxid */
  id?: string
  wxid?: string
  /** /api/contacts 的展示名 */
  name?: string
  /** /api/address-book 的展示名（已按 备注>昵称>微信号>wxid 解析） */
  display_name?: string
  /** 'group' | 'user' */
  type?: string
  is_group?: boolean
  last_msg_time?: number
  msg_count?: number
  avatar_url?: string
  remark?: string
  nick_name?: string
  alias?: string
  phone?: string
  description?: string
  sex?: number
  country?: string
  province?: string
  city?: string
  signature?: string
  labels?: string[]
  label_ids?: number[]
}

/** `GET /api/address-book` 的分页返回 */
export interface RawAddressBookResponse {
  contacts?: RawContact[]
  total?: number
  page?: number
  per_page?: number
  total_pages?: number
}

/** wechat_exp 自动探测到的微信账号数据目录（对应 `db_path/wxid/mtime/db_count/size_mb`） */
export interface RawAccount {
  db_path?: string
  wxid?: string
  mtime?: number
  db_count?: number
  size_mb?: number
}

/** `GET /api/keys/dirs` 返回的候选目录项 */
export interface RawKeyDir {
  db_path?: string
  path?: string
  wxid?: string
  mtime?: number
  db_count?: number
  size_mb?: number
  score?: number
  source?: string
  [key: string]: unknown
}

export interface RawKeyDirsResponse {
  dirs?: RawKeyDir[]
  current?: string
  mode?: string
  recommended_path?: string
  wechat_running?: boolean
  probe?: Record<string, unknown>
}

/* ==================================================================
 * 4. 上游原始数据：消息
 * ================================================================== */

/**
 * `media_info` 子结构（契约文档 §D.2）。全部可选：
 * 只有解析成功且文件确实存在时上游才会填。
 */
export interface RawMediaInfo {
  /** 等于 msg_type（3 图片 / 43 视频 / 6 文件 / 34 语音 …） */
  media_type?: number
  md5?: string
  file_name?: string
  file_size?: number
  /** 相对路径，如 msg/attach/<d1>/<d2>/Img/<fn> */
  local_path?: string
  voice_path?: string
  /** 语音/视频时长（秒） */
  duration?: number
  width?: number
  height?: number
}

/**
 * 消息对象（契约文档 §D.1，字段逐字）。
 * 注意 create_time 是 **Unix 秒**（个别旧库可能是毫秒，normalize 层做容错）。
 */
export interface RawMessage {
  /** 会话内 local_id（不是全局唯一！） */
  id?: number
  /** 实际类型 = local_type & 0xFFFF（上游已掩码） */
  msg_type?: number
  is_sender?: boolean
  /** 展示名：本人→'我'，系统→'系统消息'，群聊→成员名，未知→'未知' */
  sender_name?: string
  /** 群聊发言人 wxid；单聊常为 null */
  sender_wxid?: string | null
  sender_side?: 'me' | 'other' | 'system' | 'unknown'
  /** 判定依据：'name2id'|'fromusername'|'prefix'|'origin'|'system'|'none' */
  sender_evidence?: string | null
  /** 展示用正文（已剥离群聊 "wxid:\n" 前缀） */
  content?: string
  /** 原始正文（未剥离前缀） */
  content_raw?: string
  /** Unix 秒 */
  create_time?: number
  /** 按类型的 XML 解析结果，键随类型不同，见契约文档 §D.4 */
  xml_parsed?: Record<string, any>
  /** 分片内成员索引（不是 contact.db rowid） */
  real_sender_id?: number
  media_info?: RawMediaInfo | null
}

/** `GET /api/messages` 的分页信息 */
export interface RawPagination {
  page?: number
  per_page?: number
  total?: number
  total_pages?: number
}

/** `GET /api/messages` 的完整返回体 */
export interface RawMessagesResponse {
  messages?: RawMessage[]
  pagination?: RawPagination
  /** 仅在传 focus_local_id + focus_create_time 时出现 */
  focused?: Record<string, unknown>
}

/** `GET /api/chat/<id>/stats` */
export interface RawChatStats {
  chat_id?: string
  total_messages?: number
  date_range?: { start?: number | string; end?: number | string }
  sender_distribution?: Record<string, { name?: string; count?: number }>
}

/** `GET /api/chat/<id>/group-info` */
export interface RawGroupInfo {
  chat_id?: string
  member_count?: number
  owner?: string
  notice?: string
  members?: { wxid?: string; display_name?: string; is_owner?: boolean }[]
}

/* ==================================================================
 * 5. 供上层 `sync:probe` 直接使用的返回体
 * ================================================================== */

/**
 * 与 IPC 通道 `sync:probe` 的返回体逐字一致。
 * 用索引类型而非重新声明，保证两边任何一边改了都会在编译期暴露。
 */
export type ProbeResult = IpcContract['sync:probe']['res']
