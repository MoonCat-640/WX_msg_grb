/**
 * QQ 数据库定位
 * ------------------------------------------------------------------
 * 对应参考实现 QQFlow 的 src-tauri/src/db_scan.rs::find_qq_databases。
 *
 * QQ NT 的聊天库固定放在：
 *   %USERPROFILE%\Documents\Tencent Files\<QQ号>\nt_qq\nt_db\nt_msg.db
 * 其中 <QQ号> 目录名**必须是纯数字**（其它目录如 "nt_qq"、All Users 等要跳过）。
 * 另有一个「全局库」：
 *   %USERPROFILE%\Documents\Tencent Files\nt_qq\nt_db\nt_msg.db
 *
 * 注意：QQFlow 用 std::env::var("USERPROFILE")，在 Windows 上等价于
 * process.env.USERPROFILE；这里做个兜底（拿不到时退回 os.homedir()），
 * 避免在异常环境（服务账户、CI）下直接抛空。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { QqDatabase } from '@shared/types'
import { scoped } from '@main/core/logger'

const log = scoped('qq')

/** 取用户主目录（优先环境变量，和 QQFlow 行为一致） */
function userProfile(): string {
  return process.env.USERPROFILE || homedir()
}

/** 取漫游 AppData 目录（QQFlow 密钥文件所在地） */
function appDataRoaming(): string {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
}

/** 「Tencent Files」根目录（QQ 数据的家） */
export function tencentFilesDir(): string {
  return join(userProfile(), 'Documents', 'Tencent Files')
}

/**
 * 扫本机所有 QQ 数据库（nt_msg.db）。
 *
 * 返回按「文件大小从大到小」排序——通常最大的那个是用户的主账号，
 * 界面可以直接把第一条作为默认推荐（与 @shared/types 里 sizeMb 的注释一致）。
 * 扫不到不抛错，返回空数组（上层给出「没找到 QQ 数据」的中文提示）。
 */
export function scanQqDatabases(): QqDatabase[] {
  const results: QqDatabase[] = []
  const base = tencentFilesDir()

  if (!existsSync(base)) {
    log.info('未找到 QQ 数据目录（可能未安装或未登录过 QQ）', { base })
    return results
  }

  let names: string[]
  try {
    names = readdirSync(base)
  } catch (e) {
    log.warn('读取 QQ 数据目录失败', { base, error: String(e) })
    return results
  }

  for (const name of names) {
    // 目录名必须是纯数字（QQ 号），其它一律跳过
    if (!/^\d+$/.test(name)) continue
    const dbPath = join(base, name, 'nt_qq', 'nt_db', 'nt_msg.db')
    const info = probeFile(dbPath)
    if (info) {
      results.push({ qq: name, path: dbPath, sizeMb: info.sizeMb, modifiedAt: info.modifiedAt })
    }
  }

  // 全局库（目录名固定为 nt_qq，用 "global" 作为 qq 标识）
  const globalDb = join(base, 'nt_qq', 'nt_db', 'nt_msg.db')
  const globalInfo = probeFile(globalDb)
  if (globalInfo) {
    results.push({
      qq: 'global',
      path: globalDb,
      sizeMb: globalInfo.sizeMb,
      modifiedAt: globalInfo.modifiedAt
    })
  }

  results.sort((a, b) => b.sizeMb - a.sizeMb)
  log.info('扫描到 QQ 数据库', { 数量: results.length, 目录: base })
  return results
}

/** 探测单个 db 文件：存在且是文件才返回信息 */
function probeFile(dbPath: string): { sizeMb: number; modifiedAt: number } | null {
  try {
    if (!existsSync(dbPath)) return null
    const st = statSync(dbPath)
    if (!st.isFile()) return null
    return { sizeMb: st.size / 1024 / 1024, modifiedAt: st.mtimeMs }
  } catch (e) {
    log.warn('探测数据库文件失败', { dbPath, error: String(e) })
    return null
  }
}

/**
 * QQFlow 的密钥文件路径：%APPDATA%\qqflow\qqflow_keys.json
 * （逐字对应 commands.rs::keys_file_path）
 */
export function qqflowKeyFilePath(): string {
  return join(appDataRoaming(), 'qqflow', 'qqflow_keys.json')
}

/**
 * QQFlow 的临时缓存目录：%TEMP%\qqflow_cache
 * （对应 export_chat.rs::get_cached_db）
 *
 * ⚠️ 重要事实（已核实）：QQFlow 写进这里的缓存**仍然是加密的**，
 * 它只是把文件开头的 1024 字节头去掉后原样拷贝（见 get_cached_db 的 seek(1024)）。
 * 所以这个目录**不能**直接当明文库用——见 decrypt.ts 的降级路径说明。
 * 保留此函数是为了：
 *   1) 若用户自己用别的方式把解密后的库放进来，我们能识别并复用；
 *   2) 出错时把该路径写进日志，方便人工排查。
 */
export function qqflowCacheDir(): string {
  return join(process.env.TEMP || process.env.TMP || homedir(), 'qqflow_cache')
}
