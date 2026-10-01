<#
.SYNOPSIS
  开发启动脚本：设置代理 → 确保依赖 → 启动 electron-vite 开发服务器。

.DESCRIPTION
  依次完成：
    1. 把 Node（必要时 D:\Applications\NodeJS）加入 PATH；
    2. 设置 HTTP/HTTPS 代理环境变量（默认 http://127.0.0.1:12450）；
    3. 若 node_modules 不存在或缺少 electron，则先执行 npm install；
    4. 执行 npm run dev（electron-vite dev）。

.PARAMETER Proxy
  使用的代理，默认 http://127.0.0.1:12450；传空字符串可禁用。

.PARAMETER ForceInstall
  即使 node_modules 已存在也强制重新 npm install。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1

.NOTES
  兼容 Windows PowerShell 5.1（不使用 && / ||、三元、??）。

  常见问题：
  * 端口被占用
      electron-vite 的渲染进程走 Vite 开发服务器（默认端口 5173）。若报
      「Port 5173 is in use」，可先找出占用进程再结束它：
          netstat -ano | findstr :5173
          Stop-Process -Id <PID> -Force
      或改用其它端口（可在 electron.vite.config.ts 的 renderer.server 里指定）。
  * Electron 没下载成功
      安装 electron 时会从 GitHub 拉取二进制；失败时 node_modules\electron\dist
      会缺失，启动时报类似 「Electron failed to install correctly」。处理办法：
        - 确认代理可用后，删除 node_modules 重新 npm install；
        - 或先跑 scripts\install.ps1（项目自带安装脚本）；
        - 也可设置镜像后重装：
              $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
              npm install
  * 无边框/白屏
      多为渲染进程编译报错，看终端里 vite 的输出；也可先 npm run build 单独构建确认。
#>
[CmdletBinding()]
param(
  [string]$Proxy = "http://127.0.0.1:12450",
  [switch]$ForceInstall
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$text) {
  Write-Host ""
  Write-Host ("=== " + $text + " ===") -ForegroundColor Cyan
}
function Fail([string]$text) {
  Write-Host ""
  Write-Host ("[失败] " + $text) -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# 项目根目录
# ---------------------------------------------------------------------------
if ($PSScriptRoot) {
  $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
  $projectRoot = (Get-Location).Path
}
if (-not (Test-Path (Join-Path $projectRoot "package.json"))) {
  Fail ("未在 " + $projectRoot + " 找到 package.json，请确认脚本位于项目的 scripts\ 目录下。")
}

# ---------------------------------------------------------------------------
# 步骤 1：Node / npm
# ---------------------------------------------------------------------------
Write-Step "步骤 1/4：检查 Node / npm"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  $nodeCand = "D:\Applications\NodeJS\node.exe"
  if (Test-Path $nodeCand) {
    $env:Path = (Split-Path -Parent $nodeCand) + ";" + $env:Path
    Write-Host ("  已把 " + (Split-Path -Parent $nodeCand) + " 临时加入 PATH")
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  }
}
if (-not $nodeCmd) {
  Fail "未找到 node。请安装 Node.js（预期位置 D:\Applications\NodeJS\node.exe）。"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "未找到 npm。请确认 Node.js 安装完整。"
}
Write-Host ("  node " + (& node --version))
Write-Host ("  npm  " + (& npm --version))

Set-Location $projectRoot

# ---------------------------------------------------------------------------
# 步骤 2：环境变量（代理 + 清掉会破坏 Electron 的变量）
# ---------------------------------------------------------------------------
Write-Step "步骤 2/4：准备环境变量"

# 重要：若 ELECTRON_RUN_AS_NODE=1 存在，electron.exe 会退化成普通 Node 运行，
# 启动时报 "Cannot read properties of undefined (reading 'requestSingleInstanceLock')"。
# 某些 IDE / 宿主环境会注入这个变量，这里统一清掉，保证 Electron 以 GUI 模式启动。
if ($env:ELECTRON_RUN_AS_NODE) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Write-Host "  已清除 ELECTRON_RUN_AS_NODE（否则 Electron 会被当成 Node 运行）" -ForegroundColor Yellow
}

if ($Proxy -ne "") {
  # 探活：连不上就跳过，避免新用户被一个不存在的代理卡住
  $useProxy = $false
  try {
    $uri = [System.Uri]$Proxy
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
    $useProxy = $async.AsyncWaitHandle.WaitOne(800, $false)
    $client.Close()
  } catch {
    $useProxy = $false
  }
  if ($useProxy) {
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    Write-Host ("  HTTP_PROXY / HTTPS_PROXY = " + $Proxy)
  } else {
    Write-Host ("  代理 " + $Proxy + " 连不上，本次不使用代理") -ForegroundColor Yellow
    Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
    Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  }
} else {
  Write-Host "  已禁用代理（-Proxy 传空）"
}

# ---------------------------------------------------------------------------
# 步骤 3：依赖
# ---------------------------------------------------------------------------
Write-Step "步骤 3/4：检查依赖（node_modules）"

$needInstall = $false
$nodeModules = Join-Path $projectRoot "node_modules"
$electronDist = Join-Path $nodeModules "electron\dist"

if ($ForceInstall) {
  $needInstall = $true
  Write-Host "  已指定 -ForceInstall，强制重新安装依赖"
} elseif (-not (Test-Path $nodeModules)) {
  $needInstall = $true
  Write-Host "  未发现 node_modules，需要安装依赖"
} elseif (-not (Test-Path $electronDist)) {
  $needInstall = $true
  Write-Host ("  发现 node_modules，但缺少 " + $electronDist + "（electron 二进制可能未下载成功），将重新安装")
} else {
  Write-Host "  node_modules 就绪，跳过安装"
}

if ($needInstall) {
  Write-Host "  执行: npm install"
  & npm install
  if ($LASTEXITCODE -ne 0) {
    Fail ("npm install 失败（退出码 " + $LASTEXITCODE + "）。请检查网络/代理，或参考本脚本头部「Electron 没下载成功」的说明。")
  }
  Write-Host "  依赖安装完成" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 步骤 4：启动开发服务器
# ---------------------------------------------------------------------------
Write-Step "步骤 4/4：启动 electron-vite dev（npm run dev）"
Write-Host "  提示：按 Ctrl+C 结束开发服务器。"

& npm run dev
$code = $LASTEXITCODE
Write-Host ""
Write-Host ("npm run dev 已结束（退出码 " + $code + "）。") -ForegroundColor Yellow
exit $code
