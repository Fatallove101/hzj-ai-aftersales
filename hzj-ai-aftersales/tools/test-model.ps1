# =====================================================================
# hzj-ai-aftersales/tools/test-model.ps1
# 模型接入自检 —— 在真正把 provider 改成 qianfan 之前先跑这个
#
# 用法：
#   ... -Status     只看配置状态（不发请求）
#   ... -DryRun     打印将要发送的完整请求形状（不发请求、不打印密钥）
#   ... -Live       真的发一次最小请求（会消耗额度）
#
# 为什么要有 DryRun：千帆的接口字段与鉴权方式可能和通用格式不同，
# 先看清请求体再对照控制台「应用发布」页的示例核对，避免盲试。
# =====================================================================

param(
  [switch]$Status,
  [switch]$DryRun,
  [switch]$Live
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $Root 'engine\llm.ps1')
[void](Initialize-Llm -Root $Root)

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  模型接入自检" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

$st = Get-ModelStatus
Write-Host "  当前配置" -ForegroundColor White
Write-Host ("    provider     : " + $st.provider)
Write-Host ("    endpoint     : " + $(if ($st.endpoint_set) { $st.endpoint } else { '（未设置）' }))
Write-Host ("    model        : " + $(if ($st.model) { $st.model } else { '（未设置）' }))
Write-Host ("    API Key      : " + $(if ($st.has_key) { '已配置，指纹 ' + $st.key_fingerprint } else { '未配置' }))
Write-Host ("    密钥位置     : " + $st.key_store)
Write-Host ("    生效模式     : " + $st.mode) -ForegroundColor $(if ($st.mode -eq 'model') { 'Green' } else { 'Yellow' })
Write-Host ""

if ($st.mode -eq 'local-fallback') {
  Write-Host "  说明：当前会走本地规则引擎，不会调用任何外部模型。" -ForegroundColor Yellow
  Write-Host "        要接入模型，请按 config.example.json 里的「接入步骤」操作。" -ForegroundColor DarkGray
  Write-Host ""
}

if (-not $DryRun -and -not $Live) { exit 0 }

# ---------------------------------------------------------------------
# DryRun：打印请求形状
# ---------------------------------------------------------------------
if ($DryRun) {
  $cfg = Get-ModelConfig
  Write-Host "==============================================" -ForegroundColor Cyan
  Write-Host "  DryRun：以下是将要发送的请求形状（未发送）" -ForegroundColor Cyan
  Write-Host "==============================================" -ForegroundColor Cyan
  Write-Host ""

  $tasks = @(
    @{ task = 'translate'; params = @{ system_prompt = (Get-AgentPrompt -Name 'translate'); text = 'The dress arrived with stains'; temperature = 0.1 } },
    @{ task = 'generate';  params = @{ system_prompt = (Get-AgentPrompt -Name 'generate');  context = '客户投诉到货有污渍要求退款'; temperature = 0.7 } }
  )

  foreach ($t in $tasks) {
    $json = Build-ChatRequest -Task $t.task -Params $t.params -Config $cfg
    Write-Host ("  --- 任务: {0} ---" -f $t.task) -ForegroundColor White
    Write-Host ("  POST {0}" -f $(if ($cfg.endpoint) { $cfg.endpoint } else { '（endpoint 未配置）' }))
    Write-Host  "  Headers:"
    Write-Host  "    Content-Type : application/json; charset=utf-8"
    Write-Host  "    Authorization: Bearer <API Key 已省略，不会打印>"
    Write-Host  "  Body（已截断到 900 字符）："
    $preview = $json
    if ($preview.Length -gt 900) { $preview = $preview.Substring(0, 900) + ' …（已截断）' }
    Write-Host $preview
    Write-Host ""
  }

  # 关键：确认请求体里没有混入密钥
  $all = ($tasks | ForEach-Object { Build-ChatRequest -Task $_.task -Params $_.params -Config $cfg }) -join "`n"
  $leak = $false
  if ($st.has_key) {
    $k = Get-ApiKey -Quiet
    if ($k -and $all.Contains($k)) { $leak = $true }
  }
  Write-Host "  ── 安全检查 ──" -ForegroundColor White
  Write-Host ("    请求体内是否含明文密钥：{0}" -f $(if ($leak) { '是 ✕ 有问题！' } else { '否 ✓' })) `
    -ForegroundColor $(if ($leak) { 'Red' } else { 'Green' })
  Write-Host ("    提示词是否成功从 md 抽到：{0}" -f $(if ((Get-AgentPrompt -Name 'translate').Length -gt 200) { '是 ✓' } else { '否 ✕ 检查 prompts 目录' })) `
    -ForegroundColor $(if ((Get-AgentPrompt -Name 'translate').Length -gt 200) { 'Green' } else { 'Red' })
  Write-Host ""
  Write-Host "  请对照千帆控制台「应用发布」页给出的示例，核对上面的 endpoint 与字段名，" -ForegroundColor Yellow
  Write-Host "  确认无误后再加 -Live 参数真的发一次请求。" -ForegroundColor Yellow
  Write-Host ""
  exit 0
}

# ---------------------------------------------------------------------
# Live：真的发一次
# ---------------------------------------------------------------------
if ($Live) {
  if ($st.mode -ne 'model') {
    Write-Host "  当前未配置模型（provider=local 或缺少 Key），无法发起真实请求。" -ForegroundColor Red
    Write-Host "  请先运行 tools\set-api-key.ps1 并改好 config.local.json。" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "  发起最小测试请求…" -ForegroundColor Yellow
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-LLM -Task 'translate' -Params @{
      system_prompt = (Get-AgentPrompt -Name 'translate')
      text          = 'The dress arrived with stains and I want my money back'
      temperature   = 0.1
    }
    $sw.Stop()
    if ($null -eq $r) {
      Write-Host ("  ✕ 调用失败，已回退本地规则（耗时 {0} ms）" -f $sw.ElapsedMilliseconds) -ForegroundColor Red
      Write-Host "    常见原因：endpoint 不对 / 字段名与千帆不一致 / Key 无效 / 网络不通" -ForegroundColor Yellow
      exit 1
    }
    Write-Host ("  ✓ 调用成功（耗时 {0} ms）" -f $sw.ElapsedMilliseconds) -ForegroundColor Green
    Write-Host ""
    Write-Host "  返回内容（已过密钥掩码）："
    $preview = ($r | ConvertTo-Json -Depth 6)
    if ($preview.Length -gt 1200) { $preview = $preview.Substring(0, 1200) + ' …（已截断）' }
    Write-Host (Protect-Secret $preview)
    Write-Host ""
    exit 0
  } catch {
    $sw.Stop()
    Write-Host ("  ✕ 异常：" + (Protect-Secret $_.Exception.Message)) -ForegroundColor Red
    exit 1
  }
}
