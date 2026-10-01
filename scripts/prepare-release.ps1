# ============================================================================
# prepare-release.ps1 —— 整理 GitHub Release 附件
# ----------------------------------------------------------------------------
# 用途：把要上传到 GitHub Release 的文件收集到一个干净的目录，
#       避免把第三方工具（wechat_exp / QQFlow）误当附件上传。
#
# 产物（默认 D:\Applications\WX_message\release-assets）：
#   Setup.exe          <- 安装包（唯一的 Release 附件）
#   README.md          <- 应用说明（随附）
#   SHA256SUMS.txt     <- 校验和，便于用户核对下载完整性
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-release.ps1
#   powershell ... -File scripts\prepare-release.ps1 -Version 1.0.0
#
# 说明：本脚本只做收集与校验，不会替你上传；上传请在 GitHub 网页或 gh CLI 完成。
# 注意：本文件必须保存为 UTF-8 带 BOM，否则 Windows PowerShell 5.1 会按 GBK 解码。
# ============================================================================
[CmdletBinding()]
param(
  [string]$Version = "1.0.0",
  [string]$DeployRoot = "D:\Applications\WX_message",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$t) { Write-Host ""; Write-Host ("=== " + $t + " ===") -ForegroundColor Cyan }
function Write-Ok([string]$t)   { Write-Host ("  [OK] " + $t) -ForegroundColor Green }
function Write-Warn2([string]$t){ Write-Host ("  [注意] " + $t) -ForegroundColor Yellow }

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $DeployRoot "release-assets"
}

Write-Step ("准备 Release 附件（v" + $Version + "）")

$setup    = Join-Path $DeployRoot "Setup.exe"
$readme   = Join-Path $DeployRoot "README.md"
$notesSrc = Join-Path $PSScriptRoot ("..\docs\release-notes-v" + $Version + ".md")

if (-not (Test-Path $setup)) { throw ("未找到安装包: " + $setup + "  请先运行 scripts\build-release.ps1") }

if (Test-Path $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# 1) 安装包（唯一需要上传的附件）
Copy-Item -LiteralPath $setup -Destination (Join-Path $OutDir "Setup.exe") -Force
$setupMb = [math]::Round((Get-Item $setup).Length / 1MB, 2)
Write-Ok ("安装包: Setup.exe  (" + $setupMb + " MB)")

# 2) 应用说明
if (Test-Path $readme) {
  Copy-Item -LiteralPath $readme -Destination (Join-Path $OutDir "README.md") -Force
  Write-Ok "应用说明: README.md"
} else {
  Write-Warn2 "未找到成品 README.md，跳过"
}

# 3) Release Notes
if (Test-Path $notesSrc) {
  $notesName = "release-notes-v" + $Version + ".md"
  Copy-Item -LiteralPath $notesSrc -Destination (Join-Path $OutDir $notesName) -Force
  Write-Ok ("Release Notes: " + $notesName)
} else {
  Write-Warn2 ("未找到 " + $notesSrc + "，跳过")
}

# 4) SHA256 校验和
$sums = @()
foreach ($f in (Get-ChildItem $OutDir -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" })) {
  $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
  $sums += ($h + "  " + $f.Name)
}
Set-Content -LiteralPath (Join-Path $OutDir "SHA256SUMS.txt") -Value ($sums -join "`r`n") -Encoding ASCII
Write-Ok "SHA256SUMS.txt"

# 5) 提醒：绝不要上传的工具
Write-Step "提醒"
Write-Warn2 "以下文件位于 tools\，是第三方工具，不要作为 Release 附件上传："
Write-Warn2 "  wechat_exp*.exe / QQFlow*.exe"
Write-Warn2 "  （它们各自遵循自身许可，本项目不分发；请在 README 里指路到其 GitHub 仓库）"

Write-Step "完成"
Write-Host ("  附件目录: " + $OutDir)
Get-ChildItem $OutDir -File | ForEach-Object {
  $mb = [math]::Round($_.Length / 1MB, 2)
  Write-Host ("    " + $_.Name.PadRight(32) + $mb + " MB")
}
Write-Host ""
Write-Host "上传步骤（任选其一）：" -ForegroundColor Cyan
Write-Host ("  A) 网页：GitHub 仓库 -> Releases -> Draft a new release -> 选 tag v" + $Version + " -> 上传 Setup.exe")
Write-Host ("  B) gh CLI：gh release create v" + $Version + " Setup.exe --title `"v" + $Version + "`" --notes-file release-notes-v" + $Version + ".md")
exit 0
