/**
 * 安装后自检脚本
 * 只做提示，永远以退出码 0 结束，避免因为环境差异导致 npm install 失败。
 */
const fs = require('node:fs')
const path = require('node:path')

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

const root = path.resolve(__dirname, '..')
const lines = []

// 1) Electron 二进制是否下载成功
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const electronExe = path.join(electronDist, 'electron.exe')
if (exists(electronExe)) {
  lines.push('[OK]   Electron 运行时已就绪: ' + electronExe)
} else if (exists(electronDist)) {
  lines.push('[WARN] 找到 node_modules/electron/dist，但缺少 electron.exe，可尝试重新执行: npm rebuild electron')
} else {
  lines.push('[WARN] 未找到 Electron 运行时。请确认已开启代理后重新安装: npm install')
}

// 2) sql.js 的 wasm 是否就绪（主进程用它做本地数据库）
const wasm = path.join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
lines.push(exists(wasm) ? '[OK]   sql.js wasm 已就绪' : '[WARN] 缺少 sql.js/dist/sql-wasm.wasm')

// 3) 输出提示
console.log('\n--- wx-msg-grb 安装自检 ---')
for (const l of lines) console.log(l)
console.log('---------------------------\n')
process.exit(0)
