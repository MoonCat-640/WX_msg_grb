/**
 * wechat_exp `serve` 子进程管理
 * ------------------------------------------------------------------
 * 集成的首选方式是启动上游的本地 HTTP 服务（契约文档 §A.3）：
 *
 *   wechat_exp.exe serve [--decrypted-dir PATH] [--db-dir PATH] [--host HOST] [--port PORT]
 *
 * 默认 127.0.0.1:5000，但我们不占用 5000（那是上游默认口，可能被别的实例占着），
 * 而是从 18700 起挑一个空闲端口，避免与常见服务冲突。
 *
 * 常见失败模式（务必写进给用户的提示里，契约文档 §F.3）：
 *   - 「微信(Weixin.exe/WeChat.exe)未运行」→ 需要先启动并登录微信
 *   - 「[ERROR] Page 1 HMAC验证失败」→ 密钥错误，需要用 import-keys 补正确密钥
 *   - 「OpenProcess failed … Run as Administrator.」→ 权限不足（Hook 策略需要管理员）
 *   - 「Pattern not found in Weixin.dll — unsupported version」→ 微信版本不匹配
 * 这些错误由上游通过 SSE 的 `event: error` 返回，本层不吞掉，会原样透传给上层。
 */
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errors } from '@main/core/errors'
import { scoped } from '@main/core/logger'
import { getAppPaths } from '@main/core/paths'
import { getSettings } from '@main/core/settings'
import { configureClient, ping, pingWechatExp } from './client'
import { locateWechatExp, readVersion } from './exe-locator'
import type { WechatExpHealth } from './types'

const log = scoped('wechat-exp')

/* ==================================================================
 * 子进程所有权记录（防止崩溃后留下孤儿进程）
 * ==================================================================
 * 正常退出会走 before-quit → disposeSync → stopService，子进程会被正确带走。
 * 但如果是**强杀或崩溃**，那段清理不会执行，wechat_exp 就会变成孤儿并一直占内存。
 *
 * 做法：启动成功后把 PID 写到一个状态文件，正常停止时删掉；
 * 下次启动时如果那个 PID 还活着、且它的可执行文件路径就是我们配置的那个，
 * 就精确回收它。
 *
 * 为什么不按进程名扫杀：用户完全可能自己在用 wechat_exp 的图形界面（备份/看图），
 * 按名字杀会误伤——这个代价比留下一个孤儿进程高得多。
 */

/** 记录我们启动过的 wechat_exp 子进程 PID 与它的可执行文件路径 */
interface OwnedPid {
  pid: number
  exePath: string
  startedAt: number
}

function ownedPidFile(): string {
  return join(getAppPaths().dataDir, 'wechat-exp.pid.json')
}

function saveOwnedPid(pid: number | undefined, exePath = ''): void {
  if (!pid) return
  try {
    const data: OwnedPid = { pid, exePath, startedAt: Date.now() }
    writeFileSync(ownedPidFile(), JSON.stringify(data), 'utf8')
  } catch (e) {
    // 记不下来不影响功能，只是失去了自愈能力
    log.warn('记录 wechat_exp 子进程 PID 失败', { error: String(e) })
  }
}

function readOwnedPid(): OwnedPid | null {
  try {
    const file = ownedPidFile()
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf8')) as OwnedPid
    return typeof data?.pid === 'number' ? data : null
  } catch {
    return null
  }
}

function clearOwnedPid(): void {
  try {
    const file = ownedPidFile()
    if (existsSync(file)) unlinkSync(file)
  } catch {
    /* 删不掉也无所谓，下次启动时 PID 复用检查会兜住 */
  }
}

/**
 * 回收"上次运行遗留的、确实是我们启动的"那个子进程。
 * 只认记录里的那一个 PID，并且要二次确认它的可执行文件路径与记录一致。
 */
export function reclaimOrphanedChild(): void {
  const owned = readOwnedPid()
  if (!owned) return

  // 先确认这个 PID 还活着
  try {
    process.kill(owned.pid, 0)
  } catch {
    // 进程已不存在：清掉记录即可
    clearOwnedPid()
    return
  }

  // 再确认它确实是我们的 wechat_exp（防止 PID 被系统回收后分配给了别的程序）
  if (!isPidOfExe(owned.pid, owned.exePath)) {
    log.warn('上次记录的 PID 现在不属于 wechat_exp，放弃回收', { pid: owned.pid })
    clearOwnedPid()
    return
  }

  log.warn('发现上次运行遗留的 wechat_exp 子进程，正在回收', { pid: owned.pid })
  try {
    process.kill(owned.pid, 'SIGTERM')
  } catch {
    /* 可能刚好自己退了 */
  }
  clearOwnedPid()
}

/** 校验某个 PID 对应的可执行文件路径是否与预期一致（Windows 用 wmic 查询） */
function isPidOfExe(pid: number, expectedExePath: string): boolean {
  if (!expectedExePath) return false
  try {
    // 用 Node 内置的 execFileSync 调 PowerShell 取进程路径。
    // 只在这条"回收孤儿"的冷路径上跑，不影响正常启动速度。
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    )
    const actual = (out ?? '').trim()
    if (!actual) return false
    return actual.toLowerCase() === expectedExePath.toLowerCase()
  } catch {
    // 查不到就保守处理：当作不是我们的，不去杀
    return false
  }
}

/** 就绪等待总超时（契约要求 60 秒） */
const STARTUP_TIMEOUT_MS = 60_000
/** 内存里保留的进程输出行数（出错时附给上层排查） */
const TAIL_LINES = 40
/** 明确回避的常用端口（避免与用户其它服务/上游默认口打架） */
const BLOCKED_PORTS = new Set([3000, 3001, 5000, 5001, 8000, 8080, 8765, 8888, 9090])

/* ==================================================================
 * 内部状态
 * ================================================================== */

let proc: ChildProcessWithoutNullStreams | null = null
/** 进程退出时 resolve 的 Promise，供 stopService 等待 */
let procExit: Promise<void> | null = null
let health: WechatExpHealth = { running: false, port: 0, baseUrl: '' }
let tail: string[] = []

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pushTail(line: string): void {
  tail.push(line)
  if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES)
}

function tailText(n = 20): string {
  const lines = tail.slice(-n)
  return lines.length > 0 ? lines.join('\n') : '（无输出）'
}

/** 把子进程的 stdout/stderr 逐行写进日志，并留一份尾部用于报错 */
function attachOutput(p: ChildProcessWithoutNullStreams): void {
  const wire = (
    stream: NodeJS.ReadableStream,
    label: string,
    level: 'info' | 'warn'
  ): void => {
    const rl = createInterface({ input: stream })
    rl.on('line', (line) => {
      pushTail(line)
      if (level === 'warn') log.warn(`[wechat_exp ${label}] ${line}`)
      else log.info(`[wechat_exp ${label}] ${line}`)
    })
    rl.on('error', () => {
      /* 流被关闭时的读取错误无需处理 */
    })
  }
  // stdout 里有上游的进度与提示，按 info 记；stderr 只承载未捕获异常 traceback，按 warn 记
  wire(p.stdout, 'stdout', 'info')
  wire(p.stderr, 'stderr', 'warn')
}

/* ==================================================================
 * 端口选择
 * ================================================================== */

/** 用「试听」判断端口是否空闲：能 listen 上就是空闲 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    let settled = false
    const finish = (free: boolean): void => {
      if (settled) return
      settled = true
      try {
        srv.close()
      } catch {
        /* 未成功 listen 时 close 可能抛错，忽略 */
      }
      resolve(free)
    }
    srv.once('error', () => finish(false))
    srv.once('listening', () => finish(true))
    try {
      srv.listen({ port, host: '127.0.0.1', exclusive: true })
    } catch {
      finish(false)
    }
  })
}

/**
 * 挑选服务端口：
 *   - 设置里 wechatExpPort > 0 → 直接用（尊重用户显式选择，即便可能被占用，
 *     占用会在启动阶段以「进程退出」的形式暴露出来）
 *   - 否则从 start 起向上找第一个空闲口，跳过常用端口
 */
export async function pickFreePort(start = 18700): Promise<number> {
  const configured = getSettings().wechatExpPort
  if (configured && configured > 0) {
    log.info('使用设置中指定的 wechat_exp 端口', { port: configured })
    return configured
  }
  for (let port = start; port < start + 200; port++) {
    if (BLOCKED_PORTS.has(port)) continue
    if (await isPortFree(port)) return port
  }
  throw errors.io(`在 ${start}~${start + 200} 范围内找不到空闲端口`)
}

/* ==================================================================
 * 启动 / 停止 / 健康
 * ================================================================== */

export interface StartServiceOptions {
  /** 解密后的数据目录（不传则上游自行从配置/自动探测解析） */
  decryptedDir?: string
  /** 微信 db_storage 目录（用于媒体解析） */
  dbDir?: string
}

/**
 * 启动 `serve` 子进程并等待其就绪。
 *
 * 就绪判据用 `GET /`（静态页，不依赖解密数据）；总超时 60 秒。
 * 超时会先把进程清掉（避免留下孤儿进程），再把最后 20 行 stdout 附进错误。
 */
export async function startService(opts: StartServiceOptions = {}): Promise<WechatExpHealth> {
  // 已经在跑且健康 → 直接复用（幂等）
  if (proc && health.running && health.port > 0 && (await ping(health.port))) {
    return getHealth()
  }
  if (proc) await stopService()

  const settings = getSettings()
  // 让 client 用设置里的超时；这一步顺便完成 client 与设置的解耦（client 不 import electron）
  configureClient({ timeoutMs: settings.ioTimeoutMs })

  const loc = locateWechatExp()
  if (loc.source === 'missing' || !loc.path) {
    throw errors.notReady(
      '未找到 wechat_exp.exe。请把 wechat_exp.exe 放到程序目录（或 tools 目录），或在设置中指定其路径'
    )
  }

  const port = await pickFreePort()
  const args = ['serve', '--host', '127.0.0.1', '--port', String(port)]
  if (opts.decryptedDir) args.push('--decrypted-dir', opts.decryptedDir)
  if (opts.dbDir) args.push('--db-dir', opts.dbDir)

  tail = []
  // exe 路径含空格时**不要自己加引号**——交给 spawn 的参数数组处理即可；
  // windowsHide 避免弹出控制台黑框。
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(loc.path, args, {
      windowsHide: true,
      env: {
        ...process.env,
        // 抑制 wechat_exp 自动打开的浏览器窗口。
        //
        // 为什么需要：上游 `web/app.py` 的 run_server 里有一句无条件的
        //   timer = threading.Timer(1.0, lambda: webbrowser.open(url))
        // 也就是说只要 `serve` 一起来，它就会在 1 秒后弹一个浏览器标签页指向它自己的
        // Web 管理界面。我们这个应用只需要它的 HTTP 接口，**不想要那个页面**——
        // 每次启动都蹦出一个浏览器标签页是很糟糕的体验。
        //
        // 上游没有提供关闭它的开关（run_server 有 open_url 参数，但 CLI 没有透出），
        // 所以从环境变量下手：Python 的 webbrowser 模块会优先读 BROWSER。
        // 指向一个不存在/无输出的命令后，webbrowser.open 会静默失败，什么都不会打开。
        BROWSER: 'echo'
      }
    })
  } catch (e) {
    throw errors.external('启动 wechat_exp 失败', String(e))
  }
  proc = child
  attachOutput(child)

  // 记下我们启动的这个 PID。
  // 用途：万一应用被强杀/崩溃（before-quit 没跑到），子进程会变成孤儿并一直占着内存。
  // 下次启动时据此精确回收——**只杀我们自己记录过的那个 PID**，
  // 绝不安卓按进程名扫杀（用户可能自己在用 wechat_exp 的图形界面）。
  saveOwnedPid(child.pid, loc.path)

  // 用对象装可变状态，避免 TS 对闭包内赋值的 let 变量做过度收窄
  const spawnState: { error: NodeJS.ErrnoException | null } = { error: null }
  child.once('error', (e) => {
    spawnState.error = e
    log.error('wechat_exp 进程启动出错', {
      error: `${e.name}: ${e.message}`,
      path: loc.path
    })
  })

  procExit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.once('exit', (code, signal) => {
    // 只有「当前进程」退出才更新状态，避免旧进程的退出事件覆盖新进程的状态
    if (proc === child) {
      log.warn('wechat_exp 服务进程已退出', { code, signal, 最后输出: tailText(10) })
      health = { running: false, port: 0, baseUrl: '' }
      proc = null
    }
  })

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (spawnState.error) {
      const e = spawnState.error
      const isEnoent = e.code === 'ENOENT'
      throw errors.external(
        isEnoent
          ? '无法运行 wechat_exp.exe（文件不存在或不可执行，可能是路径错误或被安全软件拦截）'
          : '启动 wechat_exp 服务失败',
        `${e.message}\n${tailText(20)}`
      )
    }
    if (child.exitCode !== null) {
      throw errors.external(
        'wechat_exp 服务启动后立即退出，可能原因：端口被占用 / 数据目录不可用 / 微信未运行',
        tailText(20)
      )
    }
    if (await ping(port, 1500)) {
      // ⚠️ 这里不能直接认为「启动了」：ping 只证明端口上有 HTTP 应答者，
      // 而用户显式指定的端口可能被别的服务占用，此时子进程其实已经退出。
      // 所以再用 pingWechatExp 自证一次身份——读 `/` 的页面内容确认是 wechat_exp。
      const probe = await pingWechatExp(port, 1500)
      if (probe && !probe.ours) {
        // 端口被"别人"占着：这是明确的配置冲突，直接失败关闭，
        // 绝不把后续请求发给一个不认识的本地服务。
        await stopService()
        throw errors.external(
          `端口 ${port} 被其它程序占用，无法启动 wechat_exp 服务`,
          `该端口的响应不含 wechat_exp 标识。请在「设置 → 数据来源」里换一个端口，或把 wechat_exp 端口留空由程序自动挑选。响应片段：${probe.body.slice(0, 200)}`
        )
      }
      // probe 为 null（读不到 body）时按宽松处理：子进程还活着就认为起来了。
      // 这是为了兼容不同版本 `/` 页面可能不含该标识的情况，避免误判导致完全起不来。
      if (!probe && child.exitCode === null) {
        log.warn('就绪探测读不到页面内容，按「已就绪」继续（子进程存活）', { port })
      }

      // 版本探测失败不阻断启动（只影响展示）
      const version = (await readVersion(loc.path)) ?? undefined
      health = {
        running: true,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        version,
        pid: child.pid
      }
      log.info('wechat_exp 服务已就绪', { port, version, pid: child.pid, source: loc.source })
      return getHealth()
    }
    await delay(400)
  }

  // 超时：先收拾进程，再把尾部输出带进错误里，方便用户/开发者判断卡在哪
  await stopService()
  log.error('启动 wechat_exp 服务超时', { port, 最后输出: tailText(20) })
  throw errors.timeout('启动 wechat_exp 服务', `60 秒内未就绪。最后输出：\n${tailText(20)}`)
}

/**
 * 停止服务（幂等）。
 * 先 SIGTERM；3 秒后仍在，用 `taskkill /T /F` 连同子进程树一起强杀（Windows）。
 */
export async function stopService(): Promise<void> {
  const child = proc
  if (!child) {
    health = { running: false, port: 0, baseUrl: '' }
    return
  }
  log.info('正在停止 wechat_exp 服务', { pid: child.pid })

  try {
    child.kill('SIGTERM')
  } catch (e) {
    log.warn('发送 SIGTERM 失败', { error: String(e) })
  }

  const exitPromise = procExit ?? Promise.resolve()
  const result = await Promise.race([
    exitPromise.then(() => 'exited' as const),
    delay(3000).then(() => 'timeout' as const)
  ])

  if (result === 'timeout' && child.pid) {
    log.warn('SIGTERM 未能在 3 秒内结束进程，改用 taskkill 强杀进程树', { pid: child.pid })
    await new Promise<void>((resolve) => {
      execFile(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        (err) => {
          if (err) log.warn('taskkill 执行失败', { error: err.message })
          resolve()
        }
      )
    })
    await Promise.race([exitPromise, delay(1500)])
  }

  proc = null
  procExit = null
  health = { running: false, port: 0, baseUrl: '' }
  // 进程已经收干净了，把所有权记录一并删掉，免得下次启动做无用的回收尝试
  clearOwnedPid()
  log.info('wechat_exp 服务已停止')
}

/** 读取当前服务状态（快照） */
export function getHealth(): WechatExpHealth {
  return { ...health }
}

/**
 * 确保服务可用：已在跑且健康则直接返回，否则（重新）启动。
 * 上层的同步流程统一走这个函数，避免各自判断状态。
 */
export async function ensureService(opts: StartServiceOptions = {}): Promise<WechatExpHealth> {
  if (health.running && health.port > 0) {
    if (await ping(health.port)) return getHealth()
    // 进程还在但探活失败（可能已僵死）：清掉后重启
    log.warn('wechat_exp 服务探活失败，准备重启', { port: health.port })
    await stopService()
  }
  return startService(opts)
}
