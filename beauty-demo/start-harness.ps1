param(
    [ValidateRange(1, 65535)][int]$Port = 3002,
    [ValidatePattern('^[A-Za-z0-9_-]{1,100}$')][string]$UserId = 'demo-user-a',
    [string]$ApiUrl = 'http://127.0.0.1:3090',
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$uri = [Uri]$ApiUrl
if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'http' -or
    $uri.Host -notin @('127.0.0.1', 'localhost', '[::1]', '::1') -or
    $uri.AbsolutePath -ne '/' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw 'ApiUrl must be a loopback HTTP origin, for example http://127.0.0.1:3090.'
}
$ApiUrl = $ApiUrl.TrimEnd('/')
$entry = Join-Path $PSScriptRoot 'dist\server\mcp\index.js'
$patch = Join-Path $PSScriptRoot 'harness.patch.yml'
if (-not (Test-Path -LiteralPath $entry)) {
    throw 'Missing compiled MCP entry. Run npm run build in beauty-demo first.'
}
$health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 10
if ($health.status -ne 'ok' -or $health.database -ne $true) {
    throw 'Beauty API is not ready. Start beauty-demo with npm start first.'
}
$dataDir = Join-Path $PSScriptRoot 'data'
if ($env:DATABASE_PATH) {
    $database = $env:DATABASE_PATH
    if (-not [IO.Path]::IsPathRooted($database)) { $database = Join-Path $PSScriptRoot $database }
    $dataDir = [IO.Path]::GetDirectoryName($database)
}
$provision = Join-Path $PSScriptRoot 'dist\scripts\provision-mcp.js'
$null = & node $provision --user $UserId --base $ApiUrl --data-dir $dataDir
if ($LASTEXITCODE -ne 0) { throw 'Could not provision scoped MCP access.' }
$tokenFile = Join-Path $dataDir "mcp-credentials-$UserId.json"
if (-not (Test-Path -LiteralPath $tokenFile)) { throw 'MCP credential file was not created.' }
$dsh = Get-Command dsh -ErrorAction Stop
$oldUrl = $env:BEAUTY_API_URL
$oldUser = $env:BEAUTY_USER_ID
$oldEntry = $env:BEAUTY_MCP_ENTRY
$oldTokenFile = $env:BEAUTY_API_TOKEN_FILE
try {
    $env:BEAUTY_API_URL = $ApiUrl
    $env:BEAUTY_USER_ID = $UserId
    $env:BEAUTY_MCP_ENTRY = $entry
    $env:BEAUTY_API_TOKEN_FILE = $tokenFile
    Write-Host "Beauty API: $ApiUrl; user: $UserId; Harness port: $Port"
    $arguments = @('--profile', 'web', '--patch', $patch, '--host', '127.0.0.1', '--port', "$Port")
    if ($NoOpen) { $arguments += '--no-open' }
    & $dsh.Source @arguments
} finally {
    $env:BEAUTY_API_URL = $oldUrl
    $env:BEAUTY_USER_ID = $oldUser
    $env:BEAUTY_MCP_ENTRY = $oldEntry
    $env:BEAUTY_API_TOKEN_FILE = $oldTokenFile
}
