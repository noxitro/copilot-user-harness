# phase-loop の手順 3 と 5: 審査の前後に作業ツリーを採取し、審査の後に比べる。
# copilot-user-harness の install.ps1 が .github/skills/phase-loop/snapshot.ps1 に配る(直さない)。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .github/skills/phase-loop/snapshot.ps1 -Phase <N> -Stage before|after
#   (Windows 以外では pwsh -File …)
#
#   before: git diff HEAD・git status --porcelain・未追跡ファイルの sha256 を
#           e2e-artifacts/phase-N-before-review.snapshot に書く。テストディレクトリ(HARNESS.md の「環境」節)に
#           追加以外の変更(書き換え・削除・名前の変更)があれば一覧を出す
#   after : 同じものを e2e-artifacts/phase-N-after-review.snapshot に書き、before と比べる
#   終了コード: 0 = 採取した(before)/ 一致(after)、1 = 不一致(その VERDICT は無効)、
#               2 = 失敗(git リポジトリでない・before が無いなど)、3 = テストディレクトリに追加以外の変更がある(before)
#
# e2e-artifacts/ は、gitignore に入っていなくても採取から外す(ここへ書く採取結果や審査役の証拠で、前後が必ず食い違うため)。
# git の出力はバイトのまま扱う。コンソールのコードページを通すと、日本語のファイル名や Shift_JIS の中身が崩れる。
#
# Windows PowerShell 5.1 でも動くように書く。このファイルは UTF-8 (BOM 付き) で保存する。

param(
  [Parameter(Mandatory = $true)][int]$Phase,
  [Parameter(Mandatory = $true)][ValidateSet('before', 'after')][string]$Stage
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $utf8 } catch { }

$art = 'e2e-artifacts'
$except = @('--', '.', ":(exclude)$art")

function Invoke-Git([string[]]$GitArgs, [int[]]$OkCodes = @()) {
  $psi = New-Object Diagnostics.ProcessStartInfo 'git'
  $psi.Arguments = ($GitArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = (Get-Location).Path
  $p = [Diagnostics.Process]::Start($psi)
  $err = $p.StandardError.ReadToEndAsync()
  $ms = New-Object IO.MemoryStream
  $p.StandardOutput.BaseStream.CopyTo($ms)
  $p.WaitForExit()
  if ($p.ExitCode -ne 0 -and $OkCodes -notcontains $p.ExitCode) {
    throw "git $($GitArgs -join ' ') が失敗した(終了コード $($p.ExitCode)): $($err.Result)"
  }
  return , $ms.ToArray()
}
function Get-GitText([string[]]$GitArgs, [int[]]$OkCodes = @()) { return $utf8.GetString((Invoke-Git $GitArgs $OkCodes)) }

# HARNESS.md の「環境」節の「テストディレクトリ: `tests/`」(`…` を並べれば複数)。{{ }} のままなら空
function Get-TestDirs {
  if (-not (Test-Path 'HARNESS.md')) { return @() }
  $inEnv = $false
  foreach ($line in [IO.File]::ReadAllLines((Join-Path (Get-Location).Path 'HARNESS.md'), $utf8)) {
    if ($line -match '^## ') { $inEnv = $line -match '^## 環境' ; continue }
    if (-not $inEnv -or $line -notmatch 'テストディレクトリ') { continue }
    $rest = $line.Substring($line.IndexOf('テストディレクトリ'))
    $dirs = @()
    foreach ($m in [regex]::Matches($rest, '`([^`]+)`')) {
      $d = ($m.Groups[1].Value.Trim() -replace '\\', '/' -replace '^\./', '').TrimEnd('/') + '/'
      if ($d -ne '/' -and $d -ne './' -and $d -notmatch '\{\{|[*?\[]') { $dirs += $d }
    }
    return $dirs
  }
  return @()
}

# 変更ファイル(-z と -uall。名前の変更・コピーは、次の欄が元の名前)
function Get-Changes {
  $entries = (Get-GitText (@('-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '-uall') + $except)).Split([char]0)
  $out = @()
  for ($i = 0; $i -lt $entries.Length; $i++) {
    $e = $entries[$i]
    if (-not $e) { continue }
    $entry = @{ code = $e.Substring(0, 2); file = $e.Substring(3); from = $null }
    if ($entry.code -match '[RC]') { $i++; $entry.from = $entries[$i] }
    $out += $entry
  }
  return $out
}

function Get-Snapshot {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $names = (Get-GitText (@('-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z') + $except)).Split([char]0) |
      Where-Object { $_ }
    $names = [string[]]@($names)
    [Array]::Sort($names, [StringComparer]::Ordinal)
    $hashes = foreach ($n in $names) {
      $bytes = [IO.File]::ReadAllBytes((Join-Path (Get-Location).Path $n))
      (([BitConverter]::ToString($sha.ComputeHash($bytes))) -replace '-', '').ToLowerInvariant() + "  $n"
    }
  } finally { $sha.Dispose() }
  $ms = New-Object IO.MemoryStream
  $parts = @(
    (Invoke-Git (@('diff', 'HEAD') + $except)),
    $utf8.GetBytes("`n--- git status --porcelain ---`n"),
    (Invoke-Git (@('-c', 'core.quotePath=false', 'status', '--porcelain') + $except)),
    $utf8.GetBytes("`n--- untracked (sha256) ---`n" + (@($hashes) -join "`n") + "`n")
  )
  foreach ($b in $parts) { $ms.Write($b, 0, $b.Length) }
  return , $ms.ToArray()
}

try {
  $top = (Get-GitText @('rev-parse', '--show-toplevel')).Trim()
  Set-Location -LiteralPath $top
  [void](Invoke-Git @('rev-parse', '--verify', 'HEAD'))
} catch {
  Write-Output "git リポジトリの中で、コミットが 1 つ以上ある状態で実行する: $_"
  exit 2
}

$before = "$art/phase-$Phase-before-review.snapshot"
$after = "$art/phase-$Phase-after-review.snapshot"
[void](New-Item -ItemType Directory -Force -Path $art)

if ($Stage -eq 'before') {
  [IO.File]::WriteAllBytes((Join-Path $top $before), (Get-Snapshot))
  Write-Output "採取した: $before"
  $dirs = @(Get-TestDirs)
  if (-not $dirs.Count) {
    Write-Output 'テストディレクトリ: HARNESS.md の「環境」節に書かれていないので、テストの変更は見ていない(審査役だけが見る)。'
    exit 0
  }
  $touched = @(Get-Changes | Where-Object {
      $e = $_
      $e.code -ne '??' -and $e.code[0] -ne 'A' -and
      @(@($e.file, $e.from) | Where-Object { $f = $_; $f -and @($dirs | Where-Object { $f.StartsWith($_) }).Count }).Count
    } | ForEach-Object { if ($_.from) { "$($_.code) $($_.from) -> $($_.file)" } else { "$($_.code) $($_.file)" } })
  if (-not $touched.Count) {
    Write-Output "テストディレクトリ($($dirs -join ' ')): 追加以外の変更なし"
    exit 0
  }
  Write-Output "テストディレクトリ($($dirs -join ' '))に追加以外の変更がある(既定で FAIL。審査に進まず人に伝える):"
  $touched | ForEach-Object { Write-Output "  $_" }
  exit 3
}

if (-not (Test-Path $before)) {
  Write-Output "審査前の採取が無い: $before(先に -Stage before を実行する)"
  exit 2
}
$snap = Get-Snapshot
[IO.File]::WriteAllBytes((Join-Path $top $after), $snap)
$old = [IO.File]::ReadAllBytes((Join-Path $top $before))
if ([Convert]::ToBase64String($old) -ceq [Convert]::ToBase64String($snap)) {
  Write-Output "一致: $before と $after"
  exit 0
}
$diff = Get-GitText @('diff', '--no-index', '--', $before, $after) @(1)
Write-Output "不一致(この VERDICT は無効): $before と $after の差(先頭 3000 字):"
Write-Output ($diff.Substring(0, [Math]::Min(3000, $diff.Length)))
exit 1
