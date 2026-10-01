# 依赖安装脚本
# 用法： powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
# 代理说明：默认会**探测** http://127.0.0.1:12450 是否可用（本机常见的本地代理端口），
#   连得上就自动带上，连不上就跳过——所以国内直连/有其它代理的用户无需改任何东西。
#   若你用的是别的代理端口，可显式指定： -Proxy "http://127.0.0.1:7890"
#   若你的网络无需代理，可显式禁用：       -Proxy ""
#
# 注意：本文件必须保存为 UTF-8 带 BOM，否则 Windows PowerShell 5.1 会按 GBK 解码。
[CmdletBinding()]
param(
  [string]$Proxy = "http://127.0.0.1:12450"
)

$ErrorActionPreference = "Continue"

# ---- 代理探活：连不上就跳过，避免新用户被一个不存在的代理卡死 ----
$useProxy = $false
if ($Proxy -ne "") {
  try {
    $uri = [System.Uri]$Proxy
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
    $useProxy = $async.AsyncWaitHandle.WaitOne(800, $false)
    $client.Close()
  } catch {
    $useProxy = $false
  }
}

if ($useProxy) {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  # @electron/get 需要显式开启代理支持
  $env:ELECTRON_GET_USE_PROXY = "true"
  $env:GLOBAL_AGENT_HTTP_PROXY = $Proxy
  $env:GLOBAL_AGENT_HTTPS_PROXY = $Proxy
  Write-Host ("使用代理: " + $Proxy) -ForegroundColor Cyan
} else {
  if ($Proxy -ne "") {
    Write-Host ("代理 " + $Proxy + " 连不上，本次不使用代理（直连安装）") -ForegroundColor Yellow
  } else {
    Write-Host "已禁用代理（-Proxy 传空）" -ForegroundColor Cyan
  }
  Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:ELECTRON_GET_USE_PROXY -ErrorAction SilentlyContinue
}

npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "安装失败。常见原因与处理：" -ForegroundColor Yellow
  Write-Host "  * 若为 Electron 二进制下载失败，可改用国内镜像重试：" -ForegroundColor Yellow
  Write-Host '      $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"' -ForegroundColor Yellow
  Write-Host '      npm install --no-audit --no-fund' -ForegroundColor Yellow
  Write-Host "  * npm 11 默认拦截依赖的安装脚本；若 electron 未下载，执行：" -ForegroundColor Yellow
  Write-Host '      npm approve-scripts electron; npm rebuild electron' -ForegroundColor Yellow
}
exit $LASTEXITCODE
