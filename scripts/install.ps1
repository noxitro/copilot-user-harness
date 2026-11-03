# copilot-user-harness の部品を、配布先リポジトリへ配る。
#
#   install.ps1 <配布先リポジトリのパス> [-Workflow] [-Check] [-Remove] [-Force]
#
#   既定     : harness/.github/ の部品を配布先の .github/ へコピーし、種(HARNESS.md、docs/TEST_REPORT.md、
#              docs/acceptance-checklist.md)を
#              最初の 1 回だけ置き、管理ファイル .github/copilot-user-harness.json を書く
#   -Workflow: phase-gate(dynamic workflows 版。プレビュー機能)を .github/extensions/phase-gate/ に足す。
#              一度入れると、以後の実行でも配り続ける(外すには -Remove してから入れ直す)
#   -Check   : 配布先の状態を報告するだけ(何も書かない)。配る/消す差分があれば終了コード 1
#   -Remove  : この installer が置いたファイルを消す(手で編集されたものと種は残す)
#   -Force   : 手で編集・配置されたファイルも上書き(または削除)する
#   終了コード: 0 = 問題なし、1 = 差分あり(-Check)または失敗、2 = 配ったが警告あり(スキップしたファイル等)
#
# 配布先で手を入れたファイルは、-Force が無い限り上書きも削除もしない。
# 種は配布先で育てるものなので、二度目以降は置かず、-Remove でも消さない。
#
# Windows PowerShell 5.1 でも動くように書く(?:  ??  &&  -AsHashtable は使わない)。
# このファイルは UTF-8 (BOM 付き) で保存する。BOM が無いと 5.1 が日本語を文字化けさせる。

param(
  [Parameter(Position = 0)][string]$Target,
  [switch]$Workflow,
  [switch]$Check,
  [switch]$Remove,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Show-Usage {
  Write-Host '使い方: install.ps1 <配布先リポジトリのパス> [-Workflow] [-Check] [-Remove] [-Force]'
  Write-Host '  例   : install.ps1 ..\my-app'
  exit 1
}

if (-not $Target) { Show-Usage }
if ($Check -and $Remove) { Write-Host '-Check と -Remove は同時に指定できません。'; exit 1 }

$Root = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..'))
$harnessDir = Join-Path $Root 'harness'
$Target = [IO.Path]::GetFullPath($Target)
if (-not (Test-Path $Target -PathType Container)) {
  Write-Host "配布先が存在しません: $Target"
  exit 1
}
if ($Target.TrimEnd('\') -eq $Root.TrimEnd('\')) {
  Write-Host '配布先にこのリポジトリ自身は指定できません。'
  exit 1
}

$manifestRel = '.github\copilot-user-harness.json'
$manifestPath = Join-Path $Target $manifestRel
$version = '0.0.0'
$versionFile = Join-Path $Root 'VERSION'
if (Test-Path $versionFile) { $version = ([string]([IO.File]::ReadAllText($versionFile))).Trim() }
if (-not $version) { $version = '0.0.0' }

# Get-FileHash は使わない。pwsh 7 から起動されると PSModulePath が 7 の Modules を指したまま引き継がれ、
# Windows PowerShell 5.1 では Get-FileHash が見つからなくなる。
# CRLF は LF にそろえてから測る。配布先を core.autocrlf=true で clone すると部品が CRLF で取り出され、
# 生のバイトで比べると全部が「手で編集された」扱いになって更新が止まる。
# 部品の原本は LF(.gitattributes)なので、そろえても LF のファイルのハッシュは前の版と変わらない。
$latin1 = [Text.Encoding]::GetEncoding(28591) # バイトと 1 対 1 で往復できる
function Get-Hash([string]$path) {
  $text = $latin1.GetString([IO.File]::ReadAllBytes($path)).Replace("`r`n", "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($latin1.GetBytes($text)))) -replace '-', '' }
  finally { $sha.Dispose() }
}

# 管理ファイルの相対パスが、配布先の .github\ の中を指すか。管理ファイルは配布先のリポジトリにあり誰でも書き換えられるので、
# 外を指す値(絶対パス、..、: を含むもの)で配布先の外のファイルを消さないよう、読んだ時点で落とす。
$targetPrefix = $Target.TrimEnd('\') + '\'
# パスに使えない文字があると .NET Framework の Path のメソッドは例外を投げるので、それも「外を指す」として扱う。
function Test-ManagedPath([string]$rel) {
  try {
    if (-not $rel -or $rel.Contains(':') -or [IO.Path]::IsPathRooted($rel)) { return $false }
    if (-not $rel.StartsWith('.github\')) { return $false }
    if (($rel -split '[\\/]') -contains '..') { return $false }
    $full = [IO.Path]::GetFullPath((Join-Path $Target $rel))
    return $full.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)
  }
  catch { return $false }
}

# 既存の管理ファイルを読む
$recorded = @{}
$recordedWorkflow = $false
$rejected = New-Object System.Collections.Generic.List[string]
$m = $null
if (Test-Path $manifestPath) {
  $m = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($m.workflow) { $recordedWorkflow = $true }
  foreach ($prop in $m.files.PSObject.Properties) {
    if (Test-ManagedPath $prop.Name) { $recorded[$prop.Name] = $prop.Value } else { $rejected.Add($prop.Name) }
  }
}
$useWorkflow = ($Workflow -or $recordedWorkflow)

# 配るべきファイルの一覧: 配布先の相対パス -> 元ファイルの絶対パス
$desired = New-Object System.Collections.Specialized.OrderedDictionary
$githubDir = Join-Path $harnessDir '.github'
Get-ChildItem -Path $githubDir -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($githubDir.Length).TrimStart('\', '/')
  $key = ('.github\' + $rel) -replace '/', '\'
  if ($key.StartsWith('.github\extensions\') -and -not $useWorkflow) { return }
  $desired.Add($key, $_.FullName)
}

# 種ファイル(最初の 1 回だけ)
$seeds = @(
  @{ src = (Join-Path $harnessDir 'HARNESS.md'); dst = 'HARNESS.md' },
  @{ src = (Join-Path $harnessDir 'docs\TEST_REPORT.md'); dst = 'docs\TEST_REPORT.md' },
  @{ src = (Join-Path $harnessDir 'docs\acceptance-checklist.md'); dst = 'docs\acceptance-checklist.md' }
)

$actions = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
foreach ($r in $rejected) { $warnings.Add("無視した(管理ファイルのパスが .github\ の外を指している): $r") }
$newManifest = New-Object System.Collections.Specialized.OrderedDictionary

function Remove-EmptyDirs([string]$dir) {
  if (-not (Test-Path $dir -PathType Container)) { return }
  Get-ChildItem -Path $dir -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
    if (-not (Get-ChildItem -Path $_.FullName -Force | Select-Object -First 1)) { Remove-Item $_.FullName -Force }
  }
}

if ($Remove) {
  foreach ($rel in @($recorded.Keys)) {
    $dst = Join-Path $Target $rel
    if (-not (Test-Path $dst)) { continue }
    $cur = Get-Hash $dst
    if ($cur -ne $recorded[$rel] -and -not $Force) {
      $warnings.Add("残した(手で編集されている): $rel")
      continue
    }
    Remove-Item $dst -Force
    $actions.Add("削除: $rel")
  }
  if (Test-Path $manifestPath) { Remove-Item $manifestPath -Force; $actions.Add("削除: $manifestRel") }
  Remove-EmptyDirs (Join-Path $Target '.github')
}
else {
  # 配る / 更新する
  foreach ($rel in $desired.Keys) {
    $src = $desired[$rel]
    $dst = Join-Path $Target $rel
    $srcHash = Get-Hash $src
    $exists = Test-Path $dst
    $cur = $null
    if ($exists) { $cur = Get-Hash $dst }

    $doCopy = $false
    if (-not $exists) {
      $doCopy = $true
      $actions.Add("追加: $rel")
    }
    elseif (-not $recorded.ContainsKey($rel)) {
      if ($cur -eq $srcHash) { $actions.Add("取り込み(内容が同じ): $rel") }
      elseif ($Force) { $doCopy = $true; $actions.Add("上書き(-Force。手で置かれていた): $rel") }
      else { $warnings.Add("スキップ(手で置かれたファイル。-Force で上書き): $rel"); continue }
    }
    elseif ($cur -ne $recorded[$rel]) {
      if ($Force) { $doCopy = $true; $actions.Add("上書き(-Force。手で編集されていた): $rel") }
      else { $warnings.Add("スキップ(配布後に編集されている。-Force で上書き): $rel"); continue }
    }
    elseif ($cur -ne $srcHash) {
      $doCopy = $true
      $actions.Add("更新: $rel")
    }

    if ($doCopy -and -not $Check) {
      $dir = Split-Path -Parent $dst
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Copy-Item -Path $src -Destination $dst -Force
    }
    $newManifest.Add($rel, $srcHash)
  }

  # 前回配ったが今回は無いもの
  foreach ($rel in @($recorded.Keys)) {
    if ($desired.Contains($rel)) { continue }
    $dst = Join-Path $Target $rel
    if (-not (Test-Path $dst)) { continue }
    $cur = Get-Hash $dst
    if ($cur -ne $recorded[$rel] -and -not $Force) {
      $warnings.Add("残した(管理側から消えたが手で編集されている): $rel")
      $newManifest.Add($rel, $recorded[$rel])
      continue
    }
    if (-not $Check) { Remove-Item $dst -Force }
    $actions.Add("削除(管理側から消えた): $rel")
  }

  # 種ファイル
  foreach ($seed in $seeds) {
    $dst = Join-Path $Target $seed.dst
    if (Test-Path $dst) { continue }
    $actions.Add("種を置く(初回のみ): $($seed.dst)")
    if (-not $Check) {
      $dir = Split-Path -Parent $dst
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Copy-Item -Path $seed.src -Destination $dst
    }
  }

  # 証拠の置き場が git に入らないことを確かめる(配布先の .gitignore は書き換えない)
  $ignore = Join-Path $Target '.gitignore'
  $ignored = $false
  if (Test-Path $ignore) {
    foreach ($line in [IO.File]::ReadAllLines($ignore)) {
      if ($line.Trim() -match '^/?e2e-artifacts/?$') { $ignored = $true }
    }
  }
  if (-not $ignored) { $warnings.Add('.gitignore に e2e-artifacts/ が無い。証拠の置き場なので足すこと') }

  # 中身(版・ワークフローの有無・部品とハッシュ)が前回と同じなら管理ファイルを書き直さない。
  # installedAt だけが変わって、配布先に「変更なし」なのに差分が出るのを防ぐ
  $manifestSame = $false
  if ($m -and $rejected.Count -eq 0 -and [string]$m.harnessVersion -eq $version -and
      [bool]$m.workflow -eq [bool]$useWorkflow -and $recorded.Count -eq $newManifest.Count) {
    $manifestSame = $true
    foreach ($k in $newManifest.Keys) {
      if (-not $recorded.ContainsKey($k) -or $recorded[$k] -ne $newManifest[$k]) { $manifestSame = $false; break }
    }
  }

  if (-not $Check -and -not $manifestSame) {
    $files = New-Object System.Collections.Specialized.OrderedDictionary
    foreach ($k in $newManifest.Keys) { $files.Add($k, $newManifest[$k]) }
    $manifest = [ordered]@{
      harnessVersion = $version
      workflow       = $useWorkflow
      installedAt    = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
      files          = $files
    }
    $dir = Split-Path -Parent $manifestPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 5) + "`n"), $utf8NoBom)
    Remove-EmptyDirs (Join-Path $Target '.github')
  }
}

# 報告
$mode = '配布'
if ($Check) { $mode = '確認(-Check。何も書いていない)' }
if ($Remove) { $mode = '削除(-Remove)' }
Write-Host "copilot-user-harness $version -> $Target [$mode]"
if ($actions.Count -eq 0) { Write-Host '  変更なし' }
foreach ($a in $actions) { Write-Host "  $a" }
foreach ($w in $warnings) { Write-Host "  ! $w" }
if (-not $Remove -and -not $Check) {
  Write-Host ''
  Write-Host '次にすること:'
  Write-Host '  1. HARNESS.md の {{ }} を埋める(環境・意地悪テストの観点・フェーズとゲート条件)'
  Write-Host '  2. 配布先でチャットを開き、implementer と reviewer のエージェント、phase-loop のスキルが出ることを目で確かめる'
  Write-Host '  3. HARNESS.md の付録 B のとおり、Phase 0 で陰性コントロールと陽性コントロールを行う'
}

if ($Check -and $actions.Count -gt 0) { exit 1 }
if ($warnings.Count -gt 0) { exit 2 }
exit 0
