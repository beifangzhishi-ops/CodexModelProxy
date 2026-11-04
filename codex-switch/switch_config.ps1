param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath
)

$ErrorActionPreference = 'Stop'
$managedTopKeys = @(
    'model_provider',
    'model',
    'model_reasoning_effort',
    'preferred_auth_method',
    'forced_login_method',
    'model_catalog_json',
    'openai_base_url'
)
function Get-NewLine([string]$Text) {
    if ($Text.Contains("`r`n")) { return "`r`n" }
    return "`n"
}

function Get-TableSpan([string]$Text, [string]$TableName) {
    $headerPattern = '(?m)^[ \t]*\[' + [regex]::Escape($TableName) + '\][^\r\n]*(?:\r?\n|$)'
    $header = [regex]::Match($Text, $headerPattern)
    if (-not $header.Success) { return $null }

    $bodyStart = $header.Index + $header.Length
    $remainder = $Text.Substring($bodyStart)
    $next = [regex]::Match($remainder, '(?m)^[ \t]*\[[^\r\n]+\][^\r\n]*(?:\r?\n|$)')
    $end = if ($next.Success) { $bodyStart + $next.Index } else { $Text.Length }

    return ,([pscustomobject]@{
        Start  = $header.Index
        Length = $end - $header.Index
        End    = $end
    })
}

function Get-TopAssignments([string]$Text, [string[]]$Keys) {
    $firstTable = [regex]::Match($Text, '(?m)^[ \t]*\[[^\r\n]+\]')
    $topText = if ($firstTable.Success) { $Text.Substring(0, $firstTable.Index) } else { $Text }
    $wanted = @{}
    foreach ($key in $Keys) { $wanted[$key] = $true }

    $values = @{}
    $pattern = '(?m)^[ \t]*(?<key>[A-Za-z0-9_-]+)[ \t]*=[ \t]*(?<value>[^\r\n]*?)[ \t]*(?:#.*)?(?:\r?$)'
    foreach ($match in [regex]::Matches($topText, $pattern)) {
        $key = $match.Groups['key'].Value
        if (-not $wanted.ContainsKey($key)) { continue }
        if ($values.ContainsKey($key)) { throw ('Duplicate top-level key: ' + $key) }
        $values[$key] = $match.Groups['value'].Value.Trim()
    }
    return ,$values
}

function Convert-TomlString([string]$RawValue, [string]$Key) {
    $value = $RawValue.Trim()
    if ($value -match '^"([^"]*)"$') { return $matches[1] }
    if ($value -match "^'([^']*)'$") { return $matches[1] }
    throw ('Field ' + $Key + ' must be a TOML string')
}

if ([string]::IsNullOrWhiteSpace($TargetPath)) { throw 'TargetPath is required' }

$targetPath = [IO.Path]::GetFullPath($TargetPath)
$basePath = [IO.Path]::GetDirectoryName($targetPath)
$currentPath = Join-Path $basePath 'config.toml'
if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) { throw ('Target config not found: ' + $targetPath) }
if (-not (Test-Path -LiteralPath $currentPath -PathType Leaf)) { throw ('Current config not found: ' + $currentPath) }

$targetText = [IO.File]::ReadAllText($targetPath)
$currentText = [IO.File]::ReadAllText($currentPath)
$newLine = Get-NewLine $currentText

$targetTop = Get-TopAssignments $targetText $managedTopKeys
foreach ($requiredKey in @('model_provider', 'model', 'model_reasoning_effort')) {
    if (-not $targetTop.ContainsKey($requiredKey)) { throw ('Target config missing key: ' + $requiredKey) }
}

$providerId = Convert-TomlString $targetTop['model_provider'] 'model_provider'
if ($providerId -cne 'openai') { throw 'Both Codex switch profiles must use the built-in openai provider' }
if ($targetText -match '(?m)^[ \t]*\[model_providers\.') {
    throw 'Built-in openai profiles must not override provider tables'
}

# Rewrite only managed top-level keys. Preserve all other settings and sections.
$firstTable = [regex]::Match($currentText, '(?m)^[ \t]*\[[^\r\n]+\]')
$currentTopText = if ($firstTable.Success) { $currentText.Substring(0, $firstTable.Index) } else { $currentText }
$currentRestText = if ($firstTable.Success) { $currentText.Substring($firstTable.Index) } else { '' }
$topLines = [regex]::Split($currentTopText, '\r\n|\n')
$seenTop = @{}
$rewrittenTopLines = New-Object System.Collections.Generic.List[string]
$topAssignmentPattern = '^(?<indent>[ \t]*)(?<key>[A-Za-z0-9_-]+)[ \t]*=[ \t]*(?<value>[^\r\n]*?)[ \t]*(?:#.*)?$'

foreach ($line in $topLines) {
    $match = [regex]::Match($line, $topAssignmentPattern)
    $lineKey = if ($match.Success) { $match.Groups['key'].Value } else { $null }
    if (-not $match.Success -or -not ($managedTopKeys -contains $lineKey)) {
        [void]$rewrittenTopLines.Add($line)
        continue
    }

    if ($seenTop.ContainsKey($lineKey)) { throw ('Duplicate current top-level key: ' + $lineKey) }
    $seenTop[$lineKey] = $true
    if ($targetTop.ContainsKey($lineKey)) {
        [void]$rewrittenTopLines.Add($lineKey + ' = ' + $targetTop[$lineKey])
    }
}

foreach ($key in $managedTopKeys) {
    if ($targetTop.ContainsKey($key) -and -not $seenTop.ContainsKey($key)) {
        [void]$rewrittenTopLines.Add($key + ' = ' + $targetTop[$key])
    }
}

$newTopText = [string]::Join($newLine, $rewrittenTopLines)
if (-not $newTopText.EndsWith($newLine)) { $newTopText += $newLine }
$newText = $newTopText + $currentRestText

# Only the lowercase `openai` is the built-in provider whose route is switched.
# Keep the case-sensitive `OpenAI` custom provider for historical conversations:
# its own base_url is always the official ChatGPT endpoint, never the CMP URL.
$lowercaseOverride = Get-TableSpan $newText 'model_providers.openai'
if ($null -ne $lowercaseOverride) {
    $newText = $newText.Substring(0, $lowercaseOverride.Start) +
        $newText.Substring($lowercaseOverride.End)
}
if ($null -eq (Get-TableSpan $newText 'model_providers.OpenAI')) {
    if (-not $newText.EndsWith($newLine)) { $newText += $newLine }
    $legacyLines = @(
        '[model_providers.OpenAI]'
        'name = "OpenAI"'
        'base_url = "https://chatgpt.com/backend-api/codex"'
        'wire_api = "responses"'
        'requires_openai_auth = true'
        'supports_websockets = true'
        'supports_standalone_web_search = true'
    )
    $newText += $newLine + [string]::Join($newLine, $legacyLines) + $newLine
}

# Final structural checks before changing config.toml.
$finalTop = Get-TopAssignments $newText $managedTopKeys
foreach ($key in $targetTop.Keys) {
    if (-not $finalTop.ContainsKey($key)) { throw ('Switch result missing key: ' + $key) }
}
if ($null -ne (Get-TableSpan $newText 'model_providers.openai')) {
    throw 'Built-in openai provider still has a local override table'
}

if ($newText -ceq $currentText) {
    Write-Host ('Config already active: ' + [IO.Path]::GetFileName($targetPath))
    return
}

$backupDir = Join-Path $basePath 'backup-switch'
[IO.Directory]::CreateDirectory($backupDir) | Out-Null
$backupPath = Join-Path $backupDir ('config.toml.' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.bak')
[IO.File]::WriteAllText($backupPath, $currentText, [Text.UTF8Encoding]::new($false))

$tempPath = $currentPath + '.tmp.' + $PID
try {
    [IO.File]::WriteAllText($tempPath, $newText, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPath -Destination $currentPath -Force
}
finally {
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
}

Write-Host ('Backup: ' + $backupPath)
Write-Host ('Switched config: ' + [IO.Path]::GetFileName($targetPath))
