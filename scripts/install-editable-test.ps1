$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$targets = @('C:\Program Files\Common Files\Adobe\CEP\extensions\com.compxorbit.premiere','C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.compxorbit.premiere','C:\Program Files\Adobe\Adobe Premiere Pro 2025\CEP\extensions\CompX-Orbit-Premiere','C:\Program Files\Adobe\Adobe Premiere Pro 2026\CEP\extensions\CompX-Orbit-Premiere')
$log = Join-Path $source 'installation-backups\last-test-install.json'
$report = @{ completed = $false; targets = @(); error = $null }
try {
  $backup = Join-Path $source ('installation-backups\admin-test-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $backup | Out-Null
  $report.backup = $backup
  $files = @('index.html','default-templates.json','motion-presets.json','jsx\hostscript.jsx')
  foreach ($dir in @('CSXS','assets','bin','css','fonts','icons','js','lib','modules','utils')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $source $dir) -Recurse -File | Where-Object { $_.Name -notlike '._*' -and $_.Name -ne '.DS_Store' } | ForEach-Object { $_.FullName.Substring($source.Length + 1) }
  }
  $index = 0
  foreach ($target in $targets) {
    $index++
    [xml]$manifest = Get-Content -LiteralPath (Join-Path $target 'CSXS\manifest.xml')
    if ($manifest.DocumentElement.GetAttribute('ExtensionBundleId') -ne 'com.compxorbit.premiere') { throw 'Unexpected extension identity' }
    Copy-Item -LiteralPath $target -Destination (Join-Path $backup ('copy-' + $index)) -Recurse
    foreach ($relative in $files) {
      $destination = Join-Path $target $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination -Force
      if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath (Join-Path $source $relative)).Hash) { throw ('Hash mismatch: ' + $destination) }
    }
    $report.targets += @{ path = $target; verifiedFiles = $files.Count }
  }
  $report.completed = $true
} catch { $report.error = $_.Exception.Message }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $log -Encoding UTF8
if (-not $report.completed) { exit 1 }
