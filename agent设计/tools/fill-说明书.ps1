# =====================================================================
# 环贸智答 / agent设计 / tools / fill-说明书.ps1
# 把「说明书填写内容.json」原地填进官方空白模板，生成决赛成果作品说明书。
#
# 设计原则：
#   1. 原地填充 —— 保留官方模板的表格样式、页眉页脚、字体与全部【填写说明】指示；
#   2. 截图预留位不动 —— 模板里的「【插入……截图】」单元格原样保留，由使用者后续放图；
#   3. 内容与逻辑分离 —— 所有文字在 说明书填写内容.json 里，本文件只负责写进去；
#   4. 填完必须能验 —— -Verify 会重新解包，统计残留占位符、字体与关键落点。
#
# 注意：本文件必须存成 UTF-8 with BOM，否则 PowerShell 5.1 按 GBK 解码 → 中文全乱 → 语法错。
# =====================================================================
[CmdletBinding()]
param(
  [string]$Template = '',
  [string]$Content  = '',
  [string]$OutPath  = '',
  [switch]$Verify
)

# 出错时报出确切行号，别让人猜
trap {
  Write-Host ""
  Write-Host ("❌ 出错于第 " + $_.InvocationInfo.ScriptLineNumber + " 行")
  Write-Host ("   代码：" + $_.InvocationInfo.Line.Trim())
  Write-Host ("   消息：" + $_.Exception.Message)
  exit 1
}

$ErrorActionPreference = 'Stop'

# 注意：$PSScriptRoot 在 param 默认值里取不到（PS 5.1 的坑），必须在脚本体里解析
$Here = $PSScriptRoot
if ([string]::IsNullOrEmpty($Here)) { $Here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$Here = (Resolve-Path -LiteralPath $Here).Path
if ([string]::IsNullOrEmpty($Template)) { $Template = Join-Path $Here '..\template\决赛成果作品说明书（官方空白模板）.docx' }
if ([string]::IsNullOrEmpty($Content))  { $Content  = Join-Path $Here '..\说明书填写内容.json' }
if ([string]::IsNullOrEmpty($OutPath))  { $OutPath  = Join-Path $Here '..\..\环贸智答-决赛成果作品说明书.docx' }

Add-Type -AssemblyName System.IO.Compression.FileSystem

$script:WNS   = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
$script:W14NS = 'http://schemas.microsoft.com/office/word/2010/wordml'
$script:XMLNS = 'http://www.w3.org/XML/1998/namespace'

# rPr / pPr / tcPr 子元素的 schema 顺序（插错顺序 Word 会报「内容有问题」）
$script:RPR_ORDER = @('rStyle','rFonts','b','bCs','i','iCs','caps','smallCaps','strike','dstrike',
  'outline','shadow','emboss','imprint','noProof','snapToGrid','vanish','webHidden','color',
  'spacing','w','kern','position','sz','szCs','highlight','u','effect','bdr','shd','fitText',
  'vertAlign','rtl','cs','em','lang','eastAsianLayout','specVanish','oMath')
$script:PPR_ORDER = @('pStyle','keepNext','keepLines','pageBreakBefore','framePr','widowControl','numPr',
  'suppressLineNumbers','pBdr','shd','tabs','suppressAutoHyphens','kinsoku','wordWrap',
  'overflowPunct','topLinePunct','autoSpaceDE','autoSpaceDN','bidi','adjustRightInd','snapToGrid',
  'spacing','ind','contextualSpacing','mirrorIndents','suppressOverlap','jc','textDirection',
  'textAlignment','textboxTightWrap','outlineLvl','divId','cnfStyle','rPr','sectPr','pPrChange')
$script:TCPR_ORDER = @('cnfStyle','tcW','gridSpan','hMerge','vMerge','tcBorders','shd','noWrap','tcMar',
  'textDirection','tcFitText','vAlign','hideMark')

function Write-Step($msg) { Write-Host ("  " + $msg) }

# ---------------------------------------------------------------------
# XML 小工具
# ---------------------------------------------------------------------
# 关键：XmlElement.SetAttribute(local, ns, value) 的返回值是 string，
# 不吞掉就会污染管道输出（表现为满屏 "preserve / 240 / 微软雅黑"）。
function Set-W   { param($Node, [string]$Name, [string]$Value) $null = $Node.SetAttribute($Name, $script:WNS, $Value) }
# xml:space 用带前缀的两参重载，.NET 才会写成标准的 xml:space 而不是自动前缀 d5p1:space
function Set-Xml { param($Node, [string]$Name, [string]$Value) $Node.SetAttribute('xml:' + $Name, $Value) }

function Get-NsNode  { param($Node, [string]$XPath) if ($null -eq $Node) { return $null } $Node.SelectSingleNode($XPath, $script:NsMgr) }
function Get-NsNodes { param($Node, [string]$XPath) if ($null -eq $Node) { return @() } return @($Node.SelectNodes($XPath, $script:NsMgr)) }
function New-WEl { param([string]$LocalName) $script:Doc.CreateElement('w', $LocalName, $script:WNS) }

function Add-OrderedChild {
  param($Parent, $Child, [string[]]$Order)
  $myIdx = [array]::IndexOf($Order, $Child.LocalName)
  if ($myIdx -lt 0) { $myIdx = 999 }
  foreach ($c in @($Parent.ChildNodes)) {
    $cIdx = [array]::IndexOf($Order, $c.LocalName)
    if ($cIdx -lt 0) { $cIdx = 999 }
    if ($cIdx -gt $myIdx) { $null = $Parent.InsertBefore($Child, $c); return }
  }
  $null = $Parent.AppendChild($Child)
}

function Get-OrCreateRPr {
  param($Run)
  $rPr = Get-NsNode $Run 'w:rPr'
  if ($rPr) { return $rPr }
  $rPr = New-WEl 'rPr'
  if ($Run.HasChildNodes) { $null = $Run.InsertBefore($rPr, $Run.FirstChild) } else { $null = $Run.AppendChild($rPr) }
  return $rPr
}
function Get-OrCreatePPr {
  param($Para)
  $pPr = Get-NsNode $Para 'w:pPr'
  if ($pPr) { return $pPr }
  $pPr = New-WEl 'pPr'
  if ($Para.HasChildNodes) { $null = $Para.InsertBefore($pPr, $Para.FirstChild) } else { $null = $Para.AppendChild($pPr) }
  return $pPr
}
function Ensure-Child {
  param($Parent, [string]$Name, [string[]]$Order)
  $n = Get-NsNode $Parent ("w:" + $Name)
  if (-not $n) { $n = New-WEl $Name; Add-OrderedChild $Parent $n $Order }
  return $n
}

# 统一正文格式：微软雅黑 + 黑色 + 单倍行距。SizeHalfPt=0 表示不改字号。
function Set-BodyFormat {
  param($Para, [int]$SizeHalfPt = 22, [switch]$NoBold)
  $pPr = Get-OrCreatePPr $Para
  $sp = Ensure-Child $pPr 'spacing' $script:PPR_ORDER
  Set-W $sp 'line' '240'
  Set-W $sp 'lineRule' 'auto'
  foreach ($r in @(Get-NsNodes $Para 'w:r')) {
    $rPr = Get-OrCreateRPr $r
    $f = Ensure-Child $rPr 'rFonts' $script:RPR_ORDER
    foreach ($a in 'ascii', 'hAnsi', 'eastAsia', 'cs') { Set-W $f $a '微软雅黑' }
    Set-W $f 'hint' 'eastAsia'
    if ($NoBold) { $bEl = Ensure-Child $rPr 'b' $script:RPR_ORDER; Set-W $bEl 'val' '0' }
    $col = Ensure-Child $rPr 'color' $script:RPR_ORDER
    Set-W $col 'val' '000000'
    if ($SizeHalfPt -gt 0) {
      $szEl = Ensure-Child $rPr 'sz' $script:RPR_ORDER
      Set-W $szEl 'val' "$SizeHalfPt"
      $szCs = Get-NsNode $rPr 'w:szCs'
      if ($szCs) { Set-W $szCs 'val' "$SizeHalfPt" }
    }
  }
  # 段落标记（$pPr/w:rPr）也要归一：否则 ¶ 仍是模板的灰色，且会被格式自检误算成正文非黑
  $markRPr = Get-NsNode $pPr 'w:rPr'
  if ($markRPr) {
    $mf = Ensure-Child $markRPr 'rFonts' $script:RPR_ORDER
    foreach ($a in 'ascii', 'hAnsi', 'eastAsia', 'cs') { Set-W $mf $a '微软雅黑' }
    $mc = Ensure-Child $markRPr 'color' $script:RPR_ORDER
    Set-W $mc 'val' '000000'
    if ($SizeHalfPt -gt 0) { $ms = Ensure-Child $markRPr 'sz' $script:RPR_ORDER; Set-W $ms 'val' "$SizeHalfPt" }
  }
}

# 段落文字整体替换为 $Lines；先清掉原有 <w:br/>，避免残留空行
function Set-ParaText {
  param($Para, [string[]]$Lines)
  foreach ($br in @(Get-NsNodes $Para './/w:br')) { $null = $br.ParentNode.RemoveChild($br) }
  $ts = @(Get-NsNodes $Para './/w:t')
  if ($ts.Count -eq 0) {
    $run = New-WEl 'r'
    $srcRPr = Get-NsNode (Get-OrCreatePPr $Para) 'w:rPr'
    if ($srcRPr) { $null = $run.AppendChild($srcRPr.CloneNode($true)) }
    $t = New-WEl 't'
    $null = $Para.AppendChild($run); $null = $run.AppendChild($t)
    $ts = @($t)
  }
  $t0 = $ts[0]
  $t0.InnerText = [string]$Lines[0]
  Set-Xml $t0 'space' 'preserve'
  for ($i = 1; $i -lt $ts.Count; $i++) { $ts[$i].InnerText = '' }
  $anchor = $t0
  for ($i = 1; $i -lt $Lines.Count; $i++) {
    $brEl = New-WEl 'br'; Set-W $brEl 'type' 'textWrapping'
    $null = $anchor.ParentNode.InsertAfter($brEl, $anchor); $anchor = $brEl
    $t = New-WEl 't'
    $t.InnerText = [string]$Lines[$i]
    Set-Xml $t 'space' 'preserve'
    $null = $anchor.ParentNode.InsertAfter($t, $anchor); $anchor = $t
  }
}

function Get-ParaText {
  param($Para)
  $sb = New-Object System.Text.StringBuilder
  foreach ($t in @(Get-NsNodes $Para './/w:t')) { $null = $sb.Append($t.InnerText) }
  return $sb.ToString()
}

# 清掉克隆节点里重复的 w14:paraId
function Remove-ParaIds {
  param($Node)
  if ($Node.HasAttribute('paraId', $script:W14NS)) { $Node.RemoveAttribute('paraId', $script:W14NS) }
  foreach ($n in @(Get-NsNodes $Node './/*[@w14:paraId]')) { $n.RemoveAttribute('paraId', $script:W14NS) }
}

# ---------------------------------------------------------------------
# 0. 准备
# ---------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Template)) { throw "模板不存在：$Template" }
if (-not (Test-Path -LiteralPath $Content))  { throw "内容文件不存在：$Content" }
$Template = (Resolve-Path -LiteralPath $Template).Path
$Content  = (Resolve-Path -LiteralPath $Content).Path
if (-not [System.IO.Path]::IsPathRooted($OutPath)) { $OutPath = Join-Path (Get-Location).Path $OutPath }
$OutDir = Split-Path -Parent $OutPath
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$work = Join-Path $env:TEMP ('fill_spec_' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$src  = Join-Path $work 'src'
New-Item -ItemType Directory -Path $src -Force | Out-Null

Write-Host "== 1/6 解包模板 =="
[System.IO.Compression.ZipFile]::ExtractToDirectory($Template, $src)
$docPath = Join-Path $src 'word\document.xml'
if (-not (Test-Path $docPath)) { throw "模板结构异常：缺少 word/document.xml" }

$script:Doc = New-Object System.Xml.XmlDocument
$script:Doc.PreserveWhitespace = $true
$script:Doc.Load($docPath)
$script:NsMgr = New-Object System.Xml.XmlNamespaceManager($script:Doc.NameTable)
$script:NsMgr.AddNamespace('w', $script:WNS)
$script:NsMgr.AddNamespace('w14', $script:W14NS)

$body = Get-NsNode $script:Doc '//w:body'

# ---------------------------------------------------------------------
# 1. 地址映射（必须在任何修改之前一次性建立；之后只改内容不重建）
# ---------------------------------------------------------------------
Write-Host "== 2/6 建立地址映射 =="
$script:ParaMap  = @{}
$script:TableMap = @{}
$paraNo = 0; $tblNo = 0
foreach ($n in @($body.ChildNodes)) {
  if ($n.LocalName -eq 'p') {
    if ((Get-ParaText $n).Trim() -eq '') { continue }
    $paraNo++; $script:ParaMap["P$paraNo"] = $n
  } elseif ($n.LocalName -eq 'tbl') {
    $tblNo++; $script:TableMap["t$tblNo"] = $n
  }
}
Write-Step ("段落 " + $script:ParaMap.Count + " 个（基线 67），表格 " + $script:TableMap.Count + " 个（基线 16）")
if ($script:ParaMap.Count -ne 67)  { Write-Warning "段落数与基线不一致，地址可能已错位，请先核对模板！" }
if ($script:TableMap.Count -ne 16) { Write-Warning "表格数与基线不一致，请先核对模板！" }

# ---------------------------------------------------------------------
# 2. 读内容
# ---------------------------------------------------------------------
Write-Host "== 3/6 读取填写内容 =="
$rawJson = [System.IO.File]::ReadAllText($Content, (New-Object System.Text.UTF8Encoding($false)))
$C = $rawJson | ConvertFrom-Json
Write-Step ("段落改写 " + @($C.paragraphs).Count + " 处；表格填充 " + @($C.tables).Count + " 张；勾选 " + @($C.ticks).Count + " 项")

# ---------------------------------------------------------------------
# 3. 正文段落（含克隆追加段）
# ---------------------------------------------------------------------
Write-Host "== 4/6 填写正文 =="
foreach ($op in @($C.paragraphs)) {
  $addr = [string]$op.at
  if (-not $script:ParaMap.ContainsKey($addr)) { throw "找不到段落 $addr" }
  $para  = $script:ParaMap[$addr]
  $lines = @($op.lines)
  if ($lines.Count -eq 0) { throw "$addr 的 lines 为空" }
  $asBody = $true
  if (@($op.PSObject.Properties.Name) -contains 'asBody') { $asBody = [bool]$op.asBody }

  if ($lines.Count -gt 1) {
    $anchor = $para
    for ($i = 1; $i -lt $lines.Count; $i++) {
      $clone = $para.CloneNode($true)
      Remove-ParaIds $clone
      Set-ParaText $clone @([string]$lines[$i])
      if ($asBody) {
        $cps = Ensure-Child (Get-OrCreatePPr $clone) 'pStyle' $script:PPR_ORDER
        Set-W $cps 'val' '1'
        Set-BodyFormat $clone -SizeHalfPt 22 -NoBold
      } else {
        Set-BodyFormat $clone -SizeHalfPt 0
      }
      $null = $anchor.ParentNode.InsertAfter($clone, $anchor)
      $anchor = $clone
    }
  }
  Set-ParaText $para @([string]$lines[0])
  if ($asBody) {
    # 模板把答案空行设成了 heading 2（加粗），正文必须归一到 Normal
    $ps = Ensure-Child (Get-OrCreatePPr $para) 'pStyle' $script:PPR_ORDER
    Set-W $ps 'val' '1'
    Set-BodyFormat $para -SizeHalfPt 22 -NoBold
  } else {
    Set-BodyFormat $para -SizeHalfPt 0
  }
  $pv = [string]$lines[0]; if ($pv.Length -gt 30) { $pv = $pv.Substring(0, 30) + '…' }
  Write-Step ("  $addr  " + $lines.Count + " 段  " + $pv)
}

# ---------------------------------------------------------------------
# 4. 表格（不够克隆数据行，多了删）
# ---------------------------------------------------------------------
Write-Host "== 5/6 填写表格 =="
foreach ($op in @($C.tables)) {
  $addr = [string]$op.at
  if (-not $script:TableMap.ContainsKey($addr)) { throw "找不到表格 $addr" }
  $tbl = $script:TableMap[$addr]
  $headerRows = 1
  if (@($op.PSObject.Properties.Name) -contains 'headerRows') { $headerRows = [int]$op.headerRows }
  $data = @($op.rows)
  $allRows  = @(Get-NsNodes $tbl 'w:tr')
  $hdrRows  = @($allRows | Select-Object -First $headerRows)
  $dataRows = @($allRows | Select-Object -Skip $headerRows)
  if ($dataRows.Count -eq 0) { throw "$addr 没有数据行可作克隆原型" }
  $proto   = $dataRows[$dataRows.Count - 1]
  $prevRow = $proto

  for ($i = 0; $i -lt $data.Count; $i++) {
    if ($i -lt $dataRows.Count) { continue }
    $clone = $proto.CloneNode($true)
    Remove-ParaIds $clone
    $th = Get-NsNode $clone 'w:trPr/w:tblHeader'
    if ($th) { $null = $th.ParentNode.RemoveChild($th) }
    $null = $tbl.InsertAfter($clone, $prevRow)
    $dataRows += $clone
    $prevRow = $clone
  }
  if ($data.Count -lt $dataRows.Count) {
    for ($i = $data.Count; $i -lt $dataRows.Count; $i++) { $null = $tbl.RemoveChild($dataRows[$i]) }
    $dataRows = @($dataRows | Select-Object -First $data.Count)
  }

  for ($i = 0; $i -lt $data.Count; $i++) {
    $row   = $dataRows[$i]
    $cells = @($row.SelectNodes('w:tc', $script:NsMgr))
    $vals  = @($data[$i])
    if ($cells.Count -ne $vals.Count) {
      throw ("$addr 第 " + ($i + 1) + " 行单元格数不匹配：模板 " + $cells.Count + " 个，内容 " + $vals.Count + " 个")
    }
    for ($j = 0; $j -lt $cells.Count; $j++) {
      $tc    = $cells[$j]
      $paras = @(Get-NsNodes $tc 'w:p')
      if ($paras.Count -eq 0) { throw "$addr 第 $($i+1) 行第 $($j+1) 列没有段落" }
      $valRaw = [string]$vals[$j]
      $parts  = $valRaw -split "`n"
      Set-ParaText $paras[0] @($parts)
      for ($k = 1; $k -lt $paras.Count; $k++) { Set-ParaText $paras[$k] @('') }
      $plain  = $valRaw -replace "`n", ''
      $hAlign = if ($plain.Length -le 14) { 'center' } else { 'left' }
      foreach ($pp in $paras) {
        Set-BodyFormat $pp -SizeHalfPt 21 -NoBold
        $jc = Ensure-Child (Get-OrCreatePPr $pp) 'jc' $script:PPR_ORDER
        Set-W $jc 'val' $hAlign
      }
      $tcPr = Get-NsNode $tc 'w:tcPr'
      if (-not $tcPr) { $tcPr = New-WEl 'tcPr'; $null = $tc.InsertBefore($tcPr, $tc.FirstChild) }
      $va = Ensure-Child $tcPr 'vAlign' $script:TCPR_ORDER
      Set-W $va 'val' 'center'
    }
  }

  # 表头一律水平 + 垂直居中
  foreach ($hrow in $hdrRows) {
    foreach ($tc in @($hrow.SelectNodes('w:tc', $script:NsMgr))) {
      $tcPr = Get-NsNode $tc 'w:tcPr'
      if (-not $tcPr) { $tcPr = New-WEl 'tcPr'; $null = $tc.InsertBefore($tcPr, $tc.FirstChild) }
      $va = Ensure-Child $tcPr 'vAlign' $script:TCPR_ORDER
      Set-W $va 'val' 'center'
      foreach ($pp in @(Get-NsNodes $tc 'w:p')) {
        Set-BodyFormat $pp -SizeHalfPt 21 -NoBold
        $jc = Ensure-Child (Get-OrCreatePPr $pp) 'jc' $script:PPR_ORDER
        Set-W $jc 'val' 'center'
      }
    }
  }
  Write-Step ("  $addr  " + $data.Count + " 行 × " + @($data[0]).Count + " 列")
}

# ---------------------------------------------------------------------
# 5. 勾选 + 收尾
# ---------------------------------------------------------------------
Write-Host "== 6/6 勾选与收尾 =="
foreach ($addr in @($C.ticks)) {
  $a = [string]$addr
  if (-not $script:ParaMap.ContainsKey($a)) { throw "找不到检查项 $a" }
  $done = $false
  foreach ($t in @(Get-NsNodes $script:ParaMap[$a] './/w:t')) {
    if ($t.InnerText.Contains('□')) { $t.InnerText = $t.InnerText.Replace('□', '☑'); $done = $true; break }
  }
  Write-Step ("  $a  勾选 " + $(if ($done) { '成功' } else { '失败（未找到 □）' }))
}

if (@($C.PSObject.Properties.Name) -contains 'appendAfter' -and $C.appendAfter) {
  $para = $script:ParaMap[[string]$C.appendAfter.at]
  $anchor = $para
  foreach ($line in @($C.appendAfter.lines)) {
    $clone = $para.CloneNode($true)
    Remove-ParaIds $clone
    Set-ParaText $clone @([string]$line)
    Set-BodyFormat $clone -SizeHalfPt 21
    $null = $anchor.ParentNode.InsertAfter($clone, $anchor)
    $anchor = $clone
  }
  Write-Step "  已追加提交前状态说明"
}

# 整篇兜底：docDefaults 字体设为微软雅黑，避免未显式指定字体的 run 回落到 Calibri
$stylesPath = Join-Path $src 'word\styles.xml'
$stDoc = New-Object System.Xml.XmlDocument
$stDoc.PreserveWhitespace = $true
$stDoc.Load($stylesPath)
$stNs = New-Object System.Xml.XmlNamespaceManager($stDoc.NameTable)
$stNs.AddNamespace('w', $script:WNS)
$ddFonts = $stDoc.SelectSingleNode('//w:docDefaults/w:rPrDefault/w:rPr/w:rFonts', $stNs)
if ($ddFonts) {
  foreach ($a in 'ascii', 'hAnsi', 'eastAsia', 'cs') { $null = $ddFonts.SetAttribute($a, $script:WNS, '微软雅黑') }
  foreach ($a in 'asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme') {
    if ($ddFonts.HasAttribute($a, $script:WNS)) { $ddFonts.RemoveAttribute($a, $script:WNS) }
  }
  $stDoc.Save($stylesPath)
  Write-Step "  docDefaults 字体已设为微软雅黑"
}

# ---------------------------------------------------------------------
# 6. 打包（只打包 $src，绝不含中间 zip）
# ---------------------------------------------------------------------
$script:Doc.Save($docPath)
if (Test-Path -LiteralPath $OutPath) { Remove-Item -LiteralPath $OutPath -Force }
# ⚠ 不要用 ZipFile.CreateFromDirectory：.NET Framework 的实现会把条目名写成
#   "word\document.xml"（反斜杠），违反 ZIP 规范，Word 可能拒绝打开。
#   逐条写入并强制正斜杠，同时把 [Content_Types].xml 放在第一个条目。
$ctPath = Join-Path $src '[Content_Types].xml'
$ordered = @()
if (Test-Path -LiteralPath $ctPath) { $ordered += (Get-Item -LiteralPath $ctPath) }
$ordered += @(Get-ChildItem -LiteralPath $src -Recurse -File |
  Where-Object { $_.FullName -ne $ctPath } | Sort-Object FullName)
$zipOut = [System.IO.Compression.ZipFile]::Open($OutPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $madeDirs = @{}
  foreach ($f in $ordered) {
    $rel = $f.FullName.Substring($src.Length + 1).Replace('\', '/')
    # 官方模板里带目录条目（"word/" 这种），补上以保持包结构与模板一致
    $seg = $rel.Split('/')
    for ($d = 1; $d -lt $seg.Count; $d++) {
      $dirName = (($seg | Select-Object -First $d) -join '/') + '/'
      if (-not $madeDirs.ContainsKey($dirName)) {
        $madeDirs[$dirName] = $true
        $null = $zipOut.CreateEntry($dirName, [System.IO.Compression.CompressionLevel]::NoCompression)
      }
    }
    $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zipOut, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $zipOut.Dispose() }
Write-Host ""
Write-Host ("✅ 已生成：" + $OutPath + "  (" + [math]::Round((Get-Item -LiteralPath $OutPath).Length / 1KB, 1) + " KB)")

# ---------------------------------------------------------------------
# 7. 自检
# ---------------------------------------------------------------------
if ($Verify) {
  Write-Host ""
  Write-Host "== 自检 =="
  $vd = Join-Path $work 'verify'
  [System.IO.Compression.ZipFile]::ExtractToDirectory($OutPath, $vd)
  $vDoc = New-Object System.Xml.XmlDocument
  $vDoc.PreserveWhitespace = $true
  $vDoc.Load((Join-Path $vd 'word\document.xml'))
  $vn = New-Object System.Xml.XmlNamespaceManager($vDoc.NameTable)
  $vn.AddNamespace('w', $script:WNS)
  $vBody = $vDoc.SelectSingleNode('//w:body', $vn)

  $sbAll = New-Object System.Text.StringBuilder
  foreach ($t in @($vDoc.SelectNodes('//w:t', $vn))) { $null = $sbAll.Append($t.InnerText).Append("`n") }
  $leftText = $sbAll.ToString()

  Write-Host "  [格式]"
  $runTotal = @($vDoc.SelectNodes('//w:r', $vn)).Count
  $badFont = 0
  foreach ($f in @($vDoc.SelectNodes('//w:rFonts', $vn))) {
    $ea = $f.GetAttribute('eastAsia', $script:WNS)
    if ($ea -and $ea -ne '微软雅黑') { $badFont++ }
  }
  # 只看 run 里的文字色（pPr/w:rPr 是段落标记，不影响文字颜色）
  $nonBlack = 0; $greyRun = 0
  foreach ($c in @($vDoc.SelectNodes('//w:r/w:rPr/w:color', $vn))) {
    $v = $c.GetAttribute('val', $script:WNS)
    if ($v -and $v -ne '000000' -and $v -ne 'auto') { $nonBlack++ }
    if ($v -eq '666666') { $greyRun++ }
  }
  $nonSingle = 0
  foreach ($sp in @($vDoc.SelectNodes('//w:spacing[@w:line]', $vn))) {
    if ($sp.GetAttribute('line', $script:WNS) -ne '240') { $nonSingle++ }
  }
  Write-Host ("     run $runTotal 个；非微软雅黑 rFonts $badFont；非单倍行距 $nonSingle")
  Write-Host ("     非黑色文字 run $nonBlack 个（其中灰色 $greyRun 个 = 按要求保留的模板【填写说明】文字，不算正文）")

  Write-Host "  [结构]"
  Write-Host ("     表格 " + @($vDoc.SelectNodes('//w:tbl', $vn)).Count + " 张（基线 16）；表格行 " + @($vDoc.SelectNodes('//w:tr', $vn)).Count + " 行；body 段落 " + @($vBody.SelectNodes('w:p', $vn)).Count)

  Write-Host "  [残留占位符]"
  Write-Host '  [ZIP 条目名]'
  $zi = [System.IO.Compression.ZipFile]::OpenRead($OutPath)
  $badSep = @($zi.Entries | Where-Object { $_.FullName.Contains('\') })
  $zi.Dispose()
  if ($badSep.Count -eq 0) { Write-Host '     ✅ 全部使用正斜杠（Word 可正常打开）' } else { Write-Host ('     ❌ ' + $badSep.Count + ' 个条目用了反斜杠！') }

  Write-Host '  [残留占位符]'
  $ph = [regex]::Matches($leftText, '【[^】]*】')
  $any = $false
  foreach ($k in @($ph | ForEach-Object { $_.Value } | Group-Object | Sort-Object Count -Descending)) {
    Write-Host ("     " + $k.Count + " × " + $k.Name); $any = $true
  }
  if (-not $any) { Write-Host "     （无）" }

  Write-Host "  [关键落点]"
  $checks = [ordered]@{
    '作品名称'         = '环贸智答——面向多行业客服坐席'
    '勾选千帆平台'     = '☑ 千帆 AppBuilder'
    '勾选有新增或修改' = '☑ 有新增或修改'
    '汉正街本地化'     = '汉正街'
    '确定性合规闸门'   = '确定性合规闸门'
    '17 个接口'        = '17 个'
    '待法务确认'       = '待法务确认'
    '计划对接标注'     = '☑计划对接'
    '正在对接标注'     = '☑正在对接'
    '未实现线上部署'   = '☑未实现线上部署'
    '截图预留位1'      = '【插入决赛最终版MVP的真实输入或启动界面截图】'
    '截图预留位3'      = '【插入决赛最终版MVP的真实输出结果截图】'
    '架构图预留位'     = '【插入决赛最终版技术架构图或本地化资源对接示意图】'
    '本地化图预留位'   = '【插入能够证明本地化场景、资源对接或落地应用方案的截图、示意图或相关材料】'
    '保留填写说明'     = '【说明作品所在行业或公共服务背景'
    '勾选检查项'       = '☑ 已完整说明作品背景'
  }
  $fail = 0
  foreach ($k in $checks.Keys) {
    $hit = $leftText.Contains($checks[$k])
    if (-not $hit) { $fail++ }
    Write-Host ("     [" + $(if ($hit) { 'OK' } else { '缺失' }) + "] " + $k)
  }
  Write-Host ""
  if ($fail -eq 0) { Write-Host "  ✅ 自检全部通过" } else { Write-Host "  ❌ 自检有 $fail 项不通过" }
  Write-Host ("  工作目录：" + $work)
}
