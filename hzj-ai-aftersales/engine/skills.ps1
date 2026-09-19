# =====================================================================
# hzj-ai-aftersales/engine/skills.ps1  ·  技能加载器
#
# 技能 = 一个 Markdown 文件，带 YAML frontmatter 元数据 + 正文指令。
# 格式参考（真实来源）：
#   · akshaykokane/Building-Customer-Service-Agent-with-Skill.md-and-Agent-Framework
#     → Agents/Assets/Skills/<name>/SKILL.md  的 frontmatter + triggers 写法
#   · Eleven617/mall-ai-after-sales-platform (★114)
#     → app/skills/catalog.py 的 SkillDefinition 元数据模型
#       我们借用了它的 action_mode(read/draft/commit/async_task)
#       与 requires_confirmation（受控写入，人工确认）
#
# 零外部依赖：YAML 只支持本文件用到的子集（key: value 与 key: [a, b, c]）
# =====================================================================

$script:SkillDir  = $null
$script:Skills    = @()

# ---------------------------------------------------------------------
# 极简 YAML frontmatter 解析（只处理我们自己的格式，不追求通用）
# ---------------------------------------------------------------------
function ConvertFrom-SkillFrontMatter {
  param([string[]]$Lines)
  $obj = [ordered]@{}
  foreach ($raw in $Lines) {
    $line = $raw.TrimEnd()
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -match '^\s*#') { continue }
    $idx = $line.IndexOf(':')
    if ($idx -lt 1) { continue }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim()

    # 行内数组 [a, b, c]
    if ($val.StartsWith('[') -and $val.EndsWith(']')) {
      $inner = $val.Substring(1, $val.Length - 2)
      $arr = @()
      foreach ($p in ($inner -split ',')) {
        $t = $p.Trim().Trim('"').Trim("'")
        if ($t) { $arr += $t }
      }
      $obj[$key] = $arr
      continue
    }
    # 去掉包裹引号
    if ($val.Length -ge 2 -and
        (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    $obj[$key] = $val
  }
  return $obj
}

function ConvertTo-Bool {
  param($v)
  if ($null -eq $v) { return $false }
  return (@('true','yes','1','on') -contains ([string]$v).ToLower())
}

# ---------------------------------------------------------------------
# 加载一个技能文件
# ---------------------------------------------------------------------
function Read-SkillFile {
  param([Parameter(Mandatory)][string]$Path)
  $text = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
  $text = $text -replace "`r`n", "`n"

  $fm = [ordered]@{}
  $body = $text
  if ($text.StartsWith('---')) {
    $end = $text.IndexOf("`n---", 3)
    if ($end -gt 0) {
      $front = $text.Substring(3, $end - 3)
      $body  = $text.Substring($end + 4).Trim()
      $fm = ConvertFrom-SkillFrontMatter -Lines ($front -split "`n")
    }
  }

  $name = if ($fm['name']) { [string]$fm['name'] } else { [System.IO.Path]::GetFileNameWithoutExtension($Path) }

  return [pscustomobject]@{
    file                  = [System.IO.Path]::GetFileName($Path)
    name                  = $name
    name_zh               = $(if ($fm['name_zh']) { [string]$fm['name_zh'] } else { $name })
    description           = [string]$fm['description']
    version               = $(if ($fm['version']) { [string]$fm['version'] } else { 'v0.1' })
    domain                = $(if ($fm['domain']) { [string]$fm['domain'] } else { 'runtime' })
    priority              = $(if ($fm['priority']) { [string]$fm['priority'] } else { 'P2' })
    target_agent          = $(if ($fm['target_agent']) { [string]$fm['target_agent'] } else { '' })
    action_mode           = $(if ($fm['action_mode']) { [string]$fm['action_mode'] } else { 'read' })
    requires_confirmation = (ConvertTo-Bool $fm['requires_confirmation'])
    triggers              = @($fm['triggers'])
    discovery_terms       = @($fm['discovery_terms'])
    body                  = $body
    body_lines            = ($body -split "`n").Count
    loaded                = $true
  }
}

function Initialize-Skills {
  param([Parameter(Mandatory)][string]$Dir)
  $script:SkillDir = $Dir
  $script:Skills = @()
  if (-not (Test-Path $Dir)) { return 0 }
  foreach ($f in (Get-ChildItem $Dir -Filter *.md -File | Sort-Object Name)) {
    try { $script:Skills += Read-SkillFile -Path $f.FullName }
    catch { Write-Warning ("技能加载失败 " + $f.Name + " : " + $_.Exception.Message) }
  }
  return $script:Skills.Count
}

function Get-Skills { return $script:Skills }

function Get-SkillByName {
  param([string]$Name)
  return $script:Skills | Where-Object { $_.name -eq $Name } | Select-Object -First 1
}

# ---------------------------------------------------------------------
# 触发词匹配：只把"本次真正相关"的技能送进管线，避免把所有技能
# 全量塞进提示词 —— 这就是「触发词机制节省 token」的落点。
# ---------------------------------------------------------------------
function Select-SkillsByTrigger {
  param(
    [Parameter(Mandatory)][string]$Text,
    [string]$Agent = '',
    [int]$Max = 4
  )
  $lower = $Text.ToLower()
  $scored = @()
  foreach ($s in $script:Skills) {
    # 指定了 agent 就只看该环节的技能
    if ($Agent -and $s.target_agent -and $s.target_agent -ne $Agent) { continue }

    $hits = 0; $matched = @()
    foreach ($t in $s.triggers) {
      if ([string]::IsNullOrWhiteSpace($t)) { continue }
      if ($Text -like "*$t*" -or $lower -like "*$($t.ToLower())*") { $hits += 3; $matched += $t }
    }
    foreach ($t in $s.discovery_terms) {
      if ([string]::IsNullOrWhiteSpace($t)) { continue }
      if ($Text -like "*$t*" -or $lower -like "*$($t.ToLower())*") { $hits += 1; $matched += $t }
    }
    if ($hits -gt 0) {
      $scored += [pscustomobject]@{
        name = $s.name; name_zh = $s.name_zh; priority = $s.priority
        target_agent = $s.target_agent; action_mode = $s.action_mode
        requires_confirmation = $s.requires_confirmation
        score = $hits; matched = @($matched | Select-Object -Unique)
      }
    }
  }
  # P0 优先，其次命中分高
  # 注意：不要在这里用嵌套 switch —— PowerShell 5.1 解析不了
  # 哈希字面量里脚本块内再套 switch 的写法，会报 "Unexpected token '}'"
  $sorted = @($scored | Sort-Object -Property `
    @{ Expression = { if ($_.priority -eq 'P0') { 0 } elseif ($_.priority -eq 'P1') { 1 } else { 2 } } }, `
    @{ Expression = 'score'; Descending = $true })
  if ($sorted.Count -gt $Max) { $sorted = $sorted[0..($Max-1)] }
  return $sorted
}

# 取技能正文，用于注入模型提示词（当前本地模板模式暂未使用，
# 接千帆后由 pipeline 把命中的技能正文拼进 system prompt）
function Get-SkillPromptBlock {
  param([string[]]$Names)
  $parts = @()
  foreach ($n in $Names) {
    $s = Get-SkillByName -Name $n
    if ($s) { $parts += "### 技能：$($s.name_zh) ($($s.name) $($s.version))`n$($s.body)" }
  }
  return ($parts -join "`n`n")
}

# ---------------------------------------------------------------------
# Markdown 表格解析
#
# 为什么要这个：技能正文不能只是"给模型看的文本"，否则在没接模型时
# 它就是死的。把正文里的表格解析成结构化数据，本地方案也能**真正用上**技能。
# 这样技能文件就是唯一真源 —— 改 md 里的表格，程序行为跟着变。
# ---------------------------------------------------------------------
function Get-SkillMarkdownTable {
  param(
    [Parameter(Mandatory)][string]$SkillName,
    [Parameter(Mandatory)][string[]]$RequiredColumns
  )
  $sk = Get-SkillByName -Name $SkillName
  if (-not $sk) { return @() }

  $lines = $sk.body -split "`n"
  $rows = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i].Trim()
    if (-not $line.StartsWith('|')) { continue }

    # 表头行
    $cols = @($line.Trim('|') -split '\|' | ForEach-Object { $_.Trim() })
    $missing = @($RequiredColumns | Where-Object { $cols -notcontains $_ })
    if ($missing.Count -gt 0) { continue }

    # 下一行必须是分隔行 |---|---|
    if (($i + 1) -ge $lines.Count) { continue }
    $sep = $lines[$i + 1].Trim()
    if ($sep -notmatch '^\|[\s\-:\|]+\|$') { continue }

    # 逐行取数据，遇到非表格行结束
    for ($j = $i + 2; $j -lt $lines.Count; $j++) {
      $r = $lines[$j].Trim()
      if (-not $r.StartsWith('|')) { break }
      $vals = @($r.Trim('|') -split '\|' | ForEach-Object { $_.Trim() })
      if ($vals.Count -lt $cols.Count) { continue }
      $obj = [ordered]@{}
      for ($k = 0; $k -lt $cols.Count; $k++) { $obj[$cols[$k]] = $vals[$k] }
      $rows += [pscustomobject]$obj
    }
    if ($rows.Count -gt 0) { break }   # 取第一张匹配的表
  }
  return $rows
}

# 取某个技能正文里的某一行（按某个列做模糊匹配）
function Get-SkillTableRow {
  param(
    [Parameter(Mandatory)][string]$SkillName,
    [Parameter(Mandatory)][string[]]$RequiredColumns,
    [Parameter(Mandatory)][string]$MatchColumn,
    [Parameter(Mandatory)][string]$MatchValue
  )
  $rows = Get-SkillMarkdownTable -SkillName $SkillName -RequiredColumns $RequiredColumns
  foreach ($r in $rows) {
    $v = [string]$r.$MatchColumn
    if ($v -like "*$MatchValue*") { return $r }
  }
  return $null
}