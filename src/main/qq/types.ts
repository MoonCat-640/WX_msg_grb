/**
 * QQ 数据读取层 —— 内部类型
 * ------------------------------------------------------------------
 * 对应参考实现 reference/QQFlow-main（Rust/Tauri）。
 * 这里只放「本层内部使用」的类型；对外的 Conversation / ChatMessage / QqDatabase
 * 统一定义在 @shared/types，本层负责把 QQ 原始结构翻译成它们。
 *
 * 为什么单独定义 Raw* 类型：
 *   QQ 的 nt_msg.db 表用「列号」而不是列名（40001 / 40020 …）暴露字段（见
 *   QQFlow 的 export_chat.rs::MessageStore::load），列号本身没有语义，先在
 *   reader 层解析成带名字的结构，上层就不必知道这些魔数。
 */

/* ==================================================================
 * 1. 原始消息行
 * ================================================================== */

/** group_msg_table 的一行（列号含义见 QQFlow export_chat.rs） */
export interface RawQqGroupMessage {
  /** 群号（列 40021） */
  gid: string
  /** 消息 id / 时间戳（列 40001，QQ 里两者合一，可能是纳秒/毫秒/秒） */
  msgId: number
  /** 发送者 UID（列 40020，形如 u_xxxx，不是 QQ 号） */
  uid: string
  /** 发送者昵称（列 40093，可能为空） */
  nick: string
  /** 消息 BLOB（列 40800，二进制，需要 parser 解析） */
  blob: Uint8Array
}

/** c2c_msg_table 的一行（列号含义见 QQFlow export_chat.rs） */
export interface RawQqC2cMessage {
  /** 对端 UID（列 40020） */
  peer: string
  /** 消息 id / 时间戳（列 40001） */
  msgId: number
  /** 对端昵称（列 40093） */
  nick: string
  /** 消息 BLOB（列 40800） */
  blob: Uint8Array
}

/* ==================================================================
 * 2. 消息 BLOB 解析结果
 * ================================================================== */

/**
 * QQ 消息类型。
 * 与 QQFlow message_parser.rs 的 msg_type 字符串逐字一致（迁移时便于对照）：
 *   text / image / voice / video / miniapp / recall / system / other
 */
export type QqMessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'miniapp'
  | 'recall'
  | 'system'
  | 'other'

/** parser 的输出：类型 + 可读文本 */
export interface QqParsedMessage {
  msgType: QqMessageType
  content: string
}

/* ==================================================================
 * 3. 解密
 * ================================================================== */

/** 解密阶段（供进度回调与分阶段日志） */
export type QqDecryptStage = 'read' | 'derive-key' | 'decrypt' | 'write' | 'done'

/** 解密进度回调；ratio 为 0~1，未知时为 undefined */
export type QqDecryptProgress = (stage: QqDecryptStage, ratio?: number) => void

/** 页面尾部的 HMAC 算法；none 表示这是明文库 / 无法判定 */
export type QqHmacAlgorithm = 'SHA1' | 'SHA256' | 'SHA512' | 'none'

export interface QqDecryptResult {
  /** 解密后的明文 SQLite 文件路径（在 os.tmpdir()/wx-msg-grb-qq/ 下，按内容 hash 命名） */
  plainPath: string
  /** 明文内容（与 plainPath 相同），直接喂给 sql.js */
  bytes: Buffer
  /** 命中的 HMAC 算法（决定页面尾部预留区大小） */
  hmac: QqHmacAlgorithm
  /** 页面大小（QQ 为 4096） */
  pageSize: number
  /** 是否复用了已有的临时明文文件（未重新解密） */
  cached: boolean
  /** 原始文件是否未加密（直接就是明文 SQLite，走的是降级路径） */
  plaintextSource: boolean
}

/* ==================================================================
 * 4. 密钥文件（QQFlow 格式）
 * ================================================================== */

/**
 * QQFlow 的密钥文件结构：{ "<QQ号>": "<base64>" }。
 * base64 解出来的字节 = 明文密钥 XOR 循环密钥 "QQFlow2024!@#$%^"，
 * 见 QQFlow commands.rs 的 obfuscate_key / deobfuscate_key。
 */
export type QqflowKeysFile = Record<string, string>

/** 本应用保险库里存的密钥文件结构（每个密钥用保险库密钥 AES-256-GCM 加密） */
export interface QqKeyStoreFile {
  version: number
  updatedAt: number
  /** qq 号 → encryptString(明文密钥)，形如 v1.<iv>.<tag>.<ct> */
  keys: Record<string, string>
}

/* ==================================================================
 * 5. 其它
 * ================================================================== */

/** 可读性探测结果（isQqDatabaseReadable 返回） */
export interface QqReadableProbe {
  ok: boolean
  message: string
}

/** listQqMessages 的可选项 */
export interface ListQqMessagesOptions {
  /** 最多返回多少条（默认 500，按时间升序保留最近 limit 条） */
  limit?: number
}
