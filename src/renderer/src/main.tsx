/**
 * 渲染进程入口
 * ------------------------------------------------------------------
 * 样式加载顺序很重要：
 *   tokens（变量） → base（重置与排版） → components（基础组件） → layout（外壳）
 *   → views-*（各功能模块）
 * 后面的可以覆盖前面的，所以变量必须最先加载。
 *
 * 关于 StrictMode：这里**刻意不用**。
 * 它会在开发模式下把每个 effect 执行两次，而本应用的主进程调用有副作用
 * （启动同步、拉取会话列表、装载演示数据），双跑会造成难以排查的重复请求。
 * 开发期的收益（提示不安全用法）不足以抵掉这个噪音。
 */
import { createRoot } from 'react-dom/client'
import { App } from './App'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/views-login.css'
import './styles/views-detail.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 容器，index.html 可能被破坏')
}

createRoot(container).render(<App />)
