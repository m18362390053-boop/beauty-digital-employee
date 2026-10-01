param(
    [ValidateRange(1, 65535)][int]$Port = 3002,
    [ValidatePattern('^[A-Za-z0-9_-]{1,100}$')][string]$UserId = 'demo-user-a',
    [string]$ApiUrl = 'http://127.0.0.1:3090'
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
$null = Invoke-RestMethod -Uri "$ApiUrl/api/users/$UserId/card" -TimeoutSec 10
$products = Invoke-RestMethod -Uri "$ApiUrl/api/products" -TimeoutSec 10
if (@($products.items).Count -ne 1) {
    throw 'Exactly one product is required. Import product data before launching.'
}
$dsh = Get-Command dsh -ErrorAction Stop
$oldUrl = $env:BEAUTY_API_URL
$oldUser = $env:BEAUTY_USER_ID
$oldEntry = $env:BEAUTY_MCP_ENTRY
try {
    $env:BEAUTY_API_URL = $ApiUrl
    $env:BEAUTY_USER_ID = $UserId
    $env:BEAUTY_MCP_ENTRY = $entry
    Write-Host "Beauty API: $ApiUrl; user: $UserId; Harness port: $Port"
    & $dsh.Source --profile web --patch $patch --host 127.0.0.1 --port $Port
} finally {
    $env:BEAUTY_API_URL = $oldUrl
    $env:BEAUTY_USER_ID = $oldUser
    $env:BEAUTY_MCP_ENTRY = $oldEntry
}
