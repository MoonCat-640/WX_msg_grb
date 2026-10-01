/**
 * 预加载脚本
 * ------------------------------------------------------------------
 * 职责单一：把主进程能力以「白名单」形式暴露给渲染进程。
 * 不引入任何 Node 能力（nodeIntegration 关闭、contextIsolation 开启），
 * 渲染进程只能通过下面这个 api 对象访问系统。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcEventName, IpcEvents, IpcReq, IpcRes } from '@shared/ipc'
import type { Result } from '@shared/types'

const api = {
  /**
   * 调用主进程。
   * 注意：这里不 catch 异常——主进程的 ipc 路由保证永远返回 Result 包装。
   */
  invoke<K extends IpcChannel>(channel: K, payload: IpcReq<K>): Promise<Result<IpcRes<K>>> {
    return ipcRenderer.invoke(channel, payload) as Promise<Result<IpcRes<K>>>
  },

  /** 订阅主进程事件，返回取消订阅函数（组件卸载时务必调用） */
  on<K extends IpcEventName>(event: K, handler: (payload: IpcEvents[K]) => void): () => void {
    const listener = (_evt: unknown, payload: unknown): void => {
      handler(payload as IpcEvents[K])
    }
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.off(event, listener)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('wxApi', api)
} else {
  // 兜底：若构建配置意外关闭了上下文隔离，仍让界面能跑起来。
  // 用 globalThis 而不是 window —— 预加载脚本的 tsconfig 不带 DOM 类型，
  // 而且 globalThis 在两种环境下都成立。
  ;(globalThis as unknown as { wxApi: typeof api }).wxApi = api
}
