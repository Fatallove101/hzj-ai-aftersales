# =====================================================================
# hzj-ai-aftersales/engine/ocr.ps1
# 屏幕文字识别：调用 Windows 内置 OCR（Windows.Media.Ocr）
# 优点：零依赖、零成本、零网络 —— 截图不出本机，隐私最好
# 依赖：系统已安装对应语言的 OCR 语言包
# =====================================================================

Add-Type -AssemblyName System.Runtime.WindowsRuntime

[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]

$script:AsTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Wait-WinRt {
  param($Operation, [Type]$ResultType)
  $t = $script:AsTaskOp.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

function Get-OcrAvailableLanguages {
  try {
    return @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  } catch {
    return @()
  }
}

# 单语言识别，返回行数组
function Invoke-OcrOnce {
  param(
    [Parameter(Mandatory)][string]$ImagePath,
    [Parameter(Mandatory)][string]$LanguageTag
  )
  $file    = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream  = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap  = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $lang    = New-Object Windows.Globalization.Language($LanguageTag)
    $engine  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($null -eq $engine) { return $null }
    $result  = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = @()
    foreach ($line in $result.Lines) {
      if (-not [string]::IsNullOrWhiteSpace($line.Text)) { $lines += $line.Text.Trim() }
    }
    return $lines
  } finally {
    try { $stream.Dispose() } catch {}
  }
}

# 多语言识别：逐个语言跑一遍，取识别字符数最多的结果
function Invoke-ScreenOcr {
  param(
    [Parameter(Mandatory)][string]$ImagePath,
    [string[]]$Languages = @('en-US','zh-Hans-CN'),
    [string]$ForceLanguage = ''
  )
  $available = Get-OcrAvailableLanguages
  $tried = @()
  $best = $null
  $bestChars = -1
  $bestLang = ''

  $candidates = $Languages
  if (-not [string]::IsNullOrWhiteSpace($ForceLanguage)) { $candidates = @($ForceLanguage) }

  foreach ($langTag in $candidates) {
    if ($available -notcontains $langTag) { $tried += "$langTag(未安装)"; continue }
    $lines = $null
    try { $lines = Invoke-OcrOnce -ImagePath $ImagePath -LanguageTag $langTag } catch { $tried += "$langTag(失败)"; continue }
    if ($null -eq $lines) { $tried += "$langTag(引擎不可用)"; continue }
    $chars = 0
    foreach ($l in $lines) { $chars += $l.Length }
    $tried += "$langTag($chars 字)"
    if ($chars -gt $bestChars) { $bestChars = $chars; $best = $lines; $bestLang = $langTag }
  }

  if ($null -eq $best) { $best = @() }

  return [pscustomobject]@{
    lines          = $best
    text           = ($best -join "`n")
    language_used  = $bestLang
    char_count     = $bestChars
    languages_tried = $tried
    available      = $available
  }
}
