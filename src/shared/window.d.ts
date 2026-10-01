/**
 * 渲染进程可见的全局类型声明
 * 预加载脚本通过 contextBridge 暴露 `window.wxApi`，界面代码据此获得完整类型提示。
 */
import type { IpcChannel, IpcEventName, IpcEvents, IpcReq, IpcRes } from './ipc'
import type { Result } from './types'

export interface WxApi {
  /** 调用主进程能力（永远返回 Result 包装，不会抛裸异常） */
  invoke<K extends IpcChannel>(channel: K, payload: IpcReq<K>): Promise<Result<IpcRes<K>>>
  /** 订阅主进程推送的事件，返回取消订阅函数 */
  on<K extends IpcEventName>(event: K, handler: (payload: IpcEvents[K]) => void): () => void
}

declare global {
  interface Window {
    wxApi: WxApi
  }
}
