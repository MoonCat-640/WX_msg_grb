/**
 * QQ 数据读取层 —— 汇总导出
 * ------------------------------------------------------------------
 * 上层只从这里 import，不深入子模块。分层速览：
 *
 *   types.ts    本层内部类型（RawQq*Message / 解密结果 / 密钥库结构）
 *   locator.ts  扫描本机 QQ 数据库、定位 QQFlow 密钥文件与缓存目录
 *   keys.ts     密钥管理（读 QQFlow 文件 / 手动密钥 / 存进本应用保险库）
 *   decrypt.ts  SQLCipher 解密（⚠️ 未用真实库验证，详见文件头注释）
 *   parser.ts   消息 BLOB 解析（移植自 QQFlow message_parser.rs，最重要）
 *   reader.ts   用 sql.js 读表、组装会话与消息
 *   service.ts  对上层暴露的统一入口（isQqDatabaseReadable / listQq*）
 *   launcher.ts QQFlow 启动器（第二次更新需求 §2/§5：定位并启动外部依赖 QQFlow.exe）
 */

export * from './types'
export * from './locator'
export * from './keys'
export * from './decrypt'
export * from './parser'
export * from './reader'
export * from './service'
export * from './launcher'
