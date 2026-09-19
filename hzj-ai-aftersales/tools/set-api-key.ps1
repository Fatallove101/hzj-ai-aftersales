# =====================================================================
# hzj-ai-aftersales/tools/set-api-key.ps1
# 安全存放模型 API Key
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\set-api-key.ps1            # 交互式输入（推荐）
#   powershell -ExecutionPolicy Bypass -File tools\set-api-key.ps1 -Status    # 查看状态
#   powershell -ExecutionPolicy Bypass -File tools\set-api-key.ps1 -Clear     # 删除密钥
#
# 安全说明：
#   · 密钥用 Windows DPAPI(CurrentUser) 加密后写入 %APPDATA%\hzj-agent\credential.dat
#   · 不在仓库目录内、不进 git、换 Windows 账号后无法解密
#   · 本脚本不会把密钥打印出来，只显示指纹
# =====================================================================

param(
  [string]$Key,
  [switch]$Status,
  [switch]$Clear
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $Root 'engine\llm.ps1')
# 必须先初始化，Resolve-CredFile 才知道项目目录在哪（用于 .secrets 兜底）
[void](Initialize-Llm -Root $Root)

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  模型 API Key 管理" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

if ($Status) {
  $meta = Get-ApiKeyMeta
  if ($meta.configured) {
    Write-Host "  状态        : 已配置" -ForegroundColor Green
    Write-Host ("  指纹        : " + $meta.fingerprint + "  (SHA256 前 8 位，用于确认是不是这把)")
    Write-Host ("  长度        : " + $meta.length + " 字符")
    Write-Host ("  最近更新    : " + $meta.updated_at)
    Write-Host ("  存储位置    : " + $meta.store)
  } else {
    Write-Host "  状态        : 未配置" -ForegroundColor Yellow
    Write-Host ("  存储位置    : " + $meta.store + "  (尚未创建)")
  }
  Write-Host ""
  exit 0
}

if ($Clear) {
  if (Remove-ApiKey) {
    Write-Host "  已删除本地密钥。" -ForegroundColor Green
  } else {
    Write-Host "  没有找到已存储的密钥。" -ForegroundColor Yellow
  }
  Write-Host ""
  exit 0
}

# ---------- 写入 ----------
if ([string]::IsNullOrWhiteSpace($Key)) {
  Write-Host "  请输入 API Key（输入内容不会显示在屏幕上）：" -ForegroundColor Yellow
  $sec = Read-Host -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try {
    $Key = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if ([string]::IsNullOrWhiteSpace($Key)) {
  Write-Host "  未输入任何内容，已取消。" -ForegroundColor Red
  exit 1
}

[void](Set-ApiKey -Key $Key)

# 立刻清掉内存里的明文
$Key = $null
[System.GC]::Collect()

$meta = Get-ApiKeyMeta
Write-Host ""
Write-Host "  密钥已加密保存" -ForegroundColor Green
Write-Host ("  指纹     : " + $meta.fingerprint)
Write-Host ("  长度     : " + $meta.length + " 字符")
Write-Host ("  存储位置 : " + $meta.store)
Write-Host ""
Write-Host "  提示：密钥已用 Windows DPAPI 绑定到当前 Windows 账号，" -ForegroundColor DarkGray
Write-Host "        拷到别的电脑也解不开。仓库里不会有任何明文。" -ForegroundColor DarkGray
Write-Host ""
