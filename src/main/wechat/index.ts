/**
 * wechat_exp 适配层 —— 统一出口
 * ------------------------------------------------------------------
 * 上层（同步编排、IPC、任务抽取）只从这里 import，不要深入子模块，
 * 便于日后替换上游实现（例如改用 chatlab-pull 协议）时把影响限制在本层。
 *
 * 分层速览：
 *   types.ts       本层自用类型（Raw* / WechatExpHealth / ProbeResult …）
 *   exe-locator.ts 定位 wechat_exp.exe 并读取版本
 *   service.ts     管理 `serve` 子进程（端口选择 / 启动 / 停止 / 健康）
 *   client.ts      HTTP 客户端与 SSE 执行器
 *   normalize.ts   原始 JSON → 领域模型（纯函数）
 *   mock.ts        模拟数据后端（无需真实微信环境）
 */

export * from './types'
export * from './exe-locator'
export * from './service'
export * from './client'
export * from './normalize'
export * from './mock'
