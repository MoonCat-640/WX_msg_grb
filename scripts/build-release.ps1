<#
.SYNOPSIS
  一键构建并部署 WX_msg_grb（微信消息任务汇总器）的 Windows 成品。

.DESCRIPTION
  依次完成：
    0. 检查 Node / npm 是否就绪（必要时把 D:\Applications\NodeJS 加进 PATH）；
    1. npm run build                 —— electron-vite 构建，产出 out\；
    2. electron-builder --win --config electron-builder.yml
                                     —— 产出安装包（nsis）与免安装版（dir）；
    3. 整理成品到 D:\Applications\WX_message：
         - WX_msg_grb\   ← release\win-unpacked 的内容（先清空再拷贝）
         - Setup.exe     ← release\WX_msg_grb-Setup-<版本>.exe（拷贝并改名）
         - README.md     ← 项目 docs\README-应用说明.md（不存在则跳过并提示）
         - tools\        ← 项目根 / reference\ 下的 wechat_exp*.exe 与 QQFlow*.exe（有则拷贝，给免安装版兜底）
    4. 打印成品路径清单与体积。

.PARAMETER Proxy
  构建时使用的 HTTP/HTTPS 代理，默认 http://127.0.0.1:12450。传空字符串可禁用。

.PARAMETER SkipBuild
  跳过 electron-vite 构建（直接复用已有的 out\）。

.PARAMETER SkipInstaller
  只产出免安装目录，不生成安装包（给 electron-builder 传 --dir）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -SkipBuild

.NOTES
  兼容 Windows PowerShell 5.1：不使用 && / ||、三元运算符、?? 等新语法。
  本脚本只读取和部署，不修改 README.md / README_NEW.md。
#>
[CmdletBinding()]
param(
  [string]$Proxy = "http://127.0.0.1:12450",
  [switch]$SkipBuild,
  [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# 小工具函数
# ---------------------------------------------------------------------------
function Write-Step([string]$text) {
  Write-Host ""
  Write-Host ("=== " + $text + " ===") -ForegroundColor Cyan
}
function Write-Ok([string]$text) {
  Write-Host ("  [OK] " + $text) -ForegroundColor Green
}
function Write-Warn([string]$text) {
  Write-Host ("  [注意] " + $text) -ForegroundColor Yellow
}
function Write-Skip([string]$text) {
  Write-Host ("  [跳过] " + $text) -ForegroundColor Yellow
}
function Fail([string]$text) {
  Write-Host ""
  Write-Host ("[失败] " + $text) -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# 路径准备
# ---------------------------------------------------------------------------
if ($PSScriptRoot) {
  $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
  $projectRoot = (Get-Location).Path
}
if (-not (Test-Path (Join-Path $projectRoot "package.json"))) {
  Fail ("未在 " + $projectRoot + " 找到 package.json，请确认脚本位于项目的 scripts\ 目录下。")
}

$deployRoot = "D:\Applications\WX_message"
# electron-builder.yml 里 output 是相对路径 "release"，即项目根目录下的 release\
$releaseDir = Join-Path $projectRoot "release"
$appDir     = Join-Path $deployRoot "WX_msg_grb"
$setupDest  = Join-Path $deployRoot "Setup.exe"
$readmeDest = Join-Path $deployRoot "README.md"
$toolsDir   = Join-Path $deployRoot "tools"

Write-Host ("项目目录 : " + $projectRoot)
Write-Host ("成品目录 : " + $deployRoot)

# ---------------------------------------------------------------------------
# 步骤 0：Node / npm
# ---------------------------------------------------------------------------
Write-Step "步骤 0/4：检查 Node / npm 环境"

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
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  Fail "未找到 npm。请确认 Node.js 安装完整。"
}
Write-Ok ("node " + (& node --version))
Write-Ok ("npm  " + (& npm --version))

# 代理（electron-builder 首次构建需要下载 Electron / nsis / winCodeSign 等二进制）
#
# 这里做了一个「探活」：先看代理端口通不通，不通就自动跳过而不是硬设。
# 原因：代理软件（Clash / v2ray 之类）随时可能被关掉，而设一个连不上的代理
# 会让 electron-builder 报一句很难懂的 ECONNREFUSED，浪费排查时间。
if ($Proxy -ne "") {
  $proxyHost = "127.0.0.1"
  $proxyPort = 0
  try {
    $uri = [System.Uri]$Proxy
    $proxyHost = $uri.Host
    $proxyPort = $uri.Port
  } catch {
    Write-Warn ("代理地址解析失败，将不使用代理: " + $Proxy)
  }

  $reachable = $false
  if ($proxyPort -gt 0) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $async = $client.BeginConnect($proxyHost, $proxyPort, $null, $null)
      $reachable = $async.AsyncWaitHandle.WaitOne(800, $false)
      $client.Close()
    } catch {
      $reachable = $false
    }
  }

  if ($reachable) {
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    Write-Ok ("已设置代理: " + $Proxy)
  } else {
    Write-Warn ("代理 " + $Proxy + " 连不上，本次构建将不使用代理。")
    Write-Warn "  如果你还没下载过 Electron 二进制，会使 electron-builder 下载失败。"
    Write-Warn "  处理办法：打开代理软件后重跑本脚本，或传 -Proxy `"`" 明确禁用。"
    Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
    Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  }
} else {
  Write-Host "  已禁用代理（-Proxy 传空）"
  Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
}

Set-Location $projectRoot

# ---------------------------------------------------------------------------
# 步骤 1：electron-vite 构建
# ---------------------------------------------------------------------------
Write-Step "步骤 1/4：electron-vite 构建（npm run build）"

if (-not $SkipBuild) {
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    Fail ("npm run build 失败（退出码 " + $LASTEXITCODE + "）。请先修复编译错误。")
  }
  if (-not (Test-Path (Join-Path $projectRoot "out\main\index.js"))) {
    Fail "构建后未找到 out\main\index.js，electron-vite 构建可能不完整。"
  }
  Write-Ok "electron-vite 构建完成，产物在 out\"
} else {
  Write-Skip "已指定 -SkipBuild，复用现有 out\"
}

# ---------------------------------------------------------------------------
# 步骤 2：electron-builder 打包
# ---------------------------------------------------------------------------
Write-Step "步骤 2/4：electron-builder 打包（nsis 安装包 + dir 免安装版）"

$ebArgs = @()
if ($SkipInstaller) {
  $ebArgs += "--dir"
} else {
  $ebArgs += "--win"
}
$ebArgs += "--config"
$ebArgs += "electron-builder.yml"

Write-Host ("  执行: npx electron-builder " + ($ebArgs -join " "))
& npx electron-builder @ebArgs
if ($LASTEXITCODE -ne 0) {
  Fail ("electron-builder 失败（退出码 " + $LASTEXITCODE + "）。请查看上方日志。")
}
Write-Ok ("打包完成，输出目录: " + $releaseDir)

# ---------------------------------------------------------------------------
# 步骤 3：整理成品
# ---------------------------------------------------------------------------
Write-Step "步骤 3/4：整理成品到 $deployRoot"

if (-not (Test-Path $deployRoot)) {
  New-Item -ItemType Directory -Path $deployRoot -Force | Out-Null
}

# 3.1 免安装版：release\win-unpacked → WX_msg_grb\（先清空再拷贝）
$unpackedDir = Join-Path $releaseDir "win-unpacked"
if (-not (Test-Path $unpackedDir)) {
  Fail ("未找到 " + $unpackedDir + "，免安装版未生成。")
}
if (Test-Path $appDir) {
  Write-Host ("  清空旧目录: " + $appDir)
  Remove-Item -LiteralPath $appDir -Recurse -Force
}
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -Path (Join-Path $unpackedDir "*") -Destination $appDir -Recurse -Force
Write-Ok ("免安装版已部署: " + $appDir)

# 3.2 安装包：WX_msg_grb-Setup-<版本>.exe → Setup.exe
$setupSrc = Get-ChildItem -Path $releaseDir -Filter "WX_msg_grb-Setup-*.exe" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setupSrc) {
  $setupSrc = Get-ChildItem -Path $releaseDir -Filter "*Setup*.exe" -File -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if ($setupSrc) {
  Copy-Item -LiteralPath $setupSrc.FullName -Destination $setupDest -Force
  Write-Ok ("安装包已部署: " + $setupDest + "  (源: " + $setupSrc.Name + ")")
} else {
  if ($SkipInstaller) {
    Write-Skip "已指定 -SkipInstaller，不生成 Setup.exe"
  } else {
    Fail ("未在 " + $releaseDir + " 找到安装包（*Setup*.exe）。")
  }
}

# 3.3 应用说明：docs\README-应用说明.md → README.md（不存在则跳过）
$readmeSrc = Join-Path $projectRoot "docs\README-应用说明.md"
if (Test-Path $readmeSrc) {
  Copy-Item -LiteralPath $readmeSrc -Destination $readmeDest -Force
  Write-Ok ("应用说明已部署: " + $readmeDest)
} else {
  Write-Skip ("未找到 " + $readmeSrc + "（该文件由其他同事负责，本次不生成）")
}

# 3.4 第三方工具兜底：项目根 / reference\ → tools\
#     收集 wechat_exp*.exe（读取微信聊天记录）与 QQFlow*.exe（提取 QQ 数据库密钥）。
#     说明：这两个工具都是第三方开源软件，**不随安装包分发**（见 electron-builder.yml / README
#           的"依赖检查"说明）。这里只是把开发者本机已有的副本复制到免安装版目录 tools\，
#           使免安装版开箱可用；若本机没有，则跳过并提示。
$toolFiles = @()
$toolPatterns = @("wechat_exp*.exe", "QQFlow*.exe", "qqflow*.exe")
$refDir = Join-Path $projectRoot "reference"
foreach ($pat in $toolPatterns) {
  $toolFiles += Get-ChildItem -Path $projectRoot -Filter $pat -File -ErrorAction SilentlyContinue
  if (Test-Path $refDir) {
    $toolFiles += Get-ChildItem -Path $refDir -Filter $pat -File -Recurse -ErrorAction SilentlyContinue
  }
}
# 按文件名去重（同名只保留一个，避免同名文件互相覆盖）
$seenNames = @{}
$toolFiles = $toolFiles | Where-Object {
  if ($seenNames.ContainsKey($_.Name)) { $false } else { $seenNames[$_.Name] = $true; $true }
}
if ($toolFiles.Count -gt 0) {
  if (-not (Test-Path $toolsDir)) {
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
  }
  foreach ($f in $toolFiles) {
    Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $toolsDir $f.Name) -Force
    Write-Ok ("已拷贝工具: " + $f.Name + " -> " + $toolsDir)
  }
} else {
  Write-Skip ("未找到 wechat_exp*.exe / QQFlow*.exe（可稍后手动放到 " + $toolsDir + " 或免安装版目录下）")
}

# ---------------------------------------------------------------------------
# 步骤 4：成品清单
# ---------------------------------------------------------------------------
Write-Step "步骤 4/4：成品路径清单"

function Show-Item([string]$label, [string]$path) {
  if (Test-Path $path) {
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer) {
      $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue |
              Measure-Object -Property Length -Sum).Sum
    } else {
      $sum = $item.Length
    }
    if ($null -eq $sum) { $sum = 0 }
    $mb = [math]::Round($sum / 1MB, 2)
    Write-Host ("  {0,-14} {1}   ({2} MB)" -f $label, $path, $mb)
  } else {
    Write-Host ("  {0,-14} {1}   (未生成)" -f $label, $path)
  }
}

Show-Item "安装包"   $setupDest
Show-Item "免安装版" $appDir
Show-Item "应用说明" $readmeDest
Show-Item "工具目录" $toolsDir
Show-Item "构建输出" $releaseDir

Write-Host ""
Write-Host "全部完成。" -ForegroundColor Green
exit 0
