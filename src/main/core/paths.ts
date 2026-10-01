/**
 * 路径解析
 * ------------------------------------------------------------------
 * 统一管理应用运行期需要的所有目录，避免各处拼路径。
 *
 * 三种「根目录」的区别（排查问题时最容易搞混）：
 *   1. ROOT_DIR   —— 源码根 / 安装后 exe 所在目录（放 wechat_exp.exe、日志、导出）
 *   2. DATA_DIR   —— 用户数据目录（加密数据库、保险库、缓存）
 *   3. RESOURCES  —— Electron 打包资源（内置的 wechat_exp.exe 兜底位置）
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface AppPaths {
  /** 源码根目录 / 打包后 exe 所在目录 */
  rootDir: string
  /** 用户数据目录：加密数据库、保险库文件 */
  dataDir: string
  /** 日志目录 */
  logDir: string
  /** 缓存目录（头像等） */
  cacheDir: string
  /** 导出目录 */
  exportDir: string
  /** 打包资源目录（app.asar 内的 resources） */
  resourcesDir: string
}

let cached: AppPaths | null = null

/** 确保目录存在（递归创建） */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * 解析应用根目录。
 * - 打包后：exe 所在目录（用户会把 wechat_exp.exe 放在旁边）
 * - 开发时：仓库根目录（process.cwd()）
 */
export function resolveRootDir(): string {
  if (app.isPackaged) {
    // app.getPath('exe') → ...\WX_msg_grb\WX_msg_grb.exe
    return dirname(app.getPath('exe'))
  }
  return process.cwd()
}

/** 获取（并缓存）全部路径 */
export function getAppPaths(): AppPaths {
  if (cached) return cached

  const rootDir = resolveRootDir()
  const dataDir = app.getPath('userData')
  const paths: AppPaths = {
    rootDir,
    dataDir: ensureDir(dataDir),
    logDir: ensureDir(join(dataDir, 'logs')),
    cacheDir: ensureDir(join(dataDir, 'cache')),
    exportDir: ensureDir(join(rootDir, 'export')),
    resourcesDir: app.isPackaged ? process.resourcesPath : resolve(rootDir, 'resources')
  }
  cached = paths
  return paths
}

/** 清空路径缓存（测试或切换目录时用） */
export function resetPathsCache(): void {
  cached = null
}

/** 保险库文件路径 */
export function vaultFilePath(): string {
  return join(getAppPaths().dataDir, 'vault.json')
}

/** 自动解锁口令文件路径（由 Electron safeStorage / Windows DPAPI 保护） */
export function vaultKeyFilePath(): string {
  return join(getAppPaths().dataDir, 'vault.key')
}

/** 加密数据库文件路径 */
export function storeFilePath(): string {
  return join(getAppPaths().dataDir, 'store.db.enc')
}

/** 非敏感的启动配置（未加密，必须能解锁前读到） */
export function bootConfigPath(): string {
  return join(getAppPaths().dataDir, 'boot.json')
}

/**
 * 在工具目录里按文件名正则查找可执行文件（wechat_exp / QQFlow 通用）。
 *
 * 为什么要搜「上一级目录」：
 *   免安装版的目录结构通常是
 *     D:\Applications\WX_message\
 *       ├─ WX_msg_grb\      ← 程序本体（exe 在这里，rootDir 就是它）
 *       └─ tools\           ← wechat_exp.exe / QQFlow.exe 放在这里
 *   exe 所在目录与 tools 是**兄弟关系**，所以必须往上一级找一层。
 */
function findToolCandidates(namePattern: RegExp): string[] {
  const paths = getAppPaths()
  const parent = dirname(paths.rootDir)

  const roots = [
    paths.rootDir,
    join(paths.rootDir, 'tools'),
    join(paths.rootDir, 'resources'),
    join(paths.rootDir, 'reference'),
    // 免安装版：与程序目录并列的 tools\
    join(parent, 'tools'),
    // 兜底：程序目录的上一级（用户可能把 exe 直接丢在成品目录里）
    parent,
    paths.resourcesDir,
    join(paths.resourcesDir, 'tools')
  ]

  const found: string[] = []
  for (const dir of roots) {
    if (!dir || !existsSync(dir)) continue
    try {
      for (const name of readdirSync(dir)) {
        // 只认文件名，避免把目录也当成候选
        if (!namePattern.test(name)) continue
        const full = join(dir, name)
        try {
          if (statSync(full).isFile()) found.push(full)
        } catch {
          /* 忽略不可读文件 */
        }
      }
    } catch {
      /* 目录不可读则跳过 */
    }
  }
  // 去重
  return Array.from(new Set(found))
}

/**
 * 查找 wechat_exp.exe 的候选位置（按优先级）。
 * 需求里的文件名可能带 `_2` 之类的后缀，所以按前缀模糊匹配。
 */
export function findWechatExpCandidates(): string[] {
  return findToolCandidates(/^wechat_exp.*\.exe$/i)
}

/**
 * 查找 QQFlow.exe 的候选位置（第二次更新需求 §2/§5）。
 *
 * 说明：QQFlow 是第三方开源工具，**不随本软件分发**（见 README「依赖与许可证」）。
 * 用户在设置里也可以手动指定路径；这里只是自动搜索的候选列表。
 * 兼容两种命名：官方产物 QQFlow.exe 与 Rust 原始产物 qqflow-rust.exe。
 */
export function findQqflowCandidates(): string[] {
  return findToolCandidates(/^qqflow.*\.exe$/i)
}
