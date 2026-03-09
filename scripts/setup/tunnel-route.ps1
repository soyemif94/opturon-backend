param(
  [string]$TunnelName = '',
  [string]$PublicHost = ''
)

$ErrorActionPreference = 'Stop'

if (-not $TunnelName) {
  $TunnelName = if ($env:CLOUDFLARED_TUNNEL_NAME) { [string]$env:CLOUDFLARED_TUNNEL_NAME } else { 'clinicai-api' }
}
if (-not $PublicHost) {
  $PublicHost = if ($env:PROD_PUBLIC_HOST) { [string]$env:PROD_PUBLIC_HOST } else { 'api.opturon.com' }
}

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
  Write-Error "cloudflared not found in PATH. Install cloudflared and retry."
  exit 1
}

Write-Host "Routing DNS with cloudflared tunnel route dns $TunnelName $PublicHost"

try {
  $output = & $cloudflared.Source tunnel route dns $TunnelName $PublicHost 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "cloudflared route failed (exit $LASTEXITCODE):`n$output"
    exit 1
  }
  Write-Host $output
  Write-Host "DNS route updated: $PublicHost -> $TunnelName"
  exit 0
} catch {
  Write-Error "Failed to update DNS route: $($_.Exception.Message)"
  exit 1
}

