# Executa discovery + migrations na VPS (após instalar chave SSH).
# Uso:
#   1. No SSH da VPS: bash scripts/vps/00-add-agent-ssh-key.sh  (ou cole o conteúdo)
#   2. No PowerShell local: .\scripts\vps\run-from-windows.ps1 -Phase discover
#   3. Confira o container e rode: .\scripts\vps\run-from-windows.ps1 -Phase migrate -ContainerId <id>

param(
  [ValidateSet("discover", "migrate")]
  [string]$Phase = "discover",
  [string]$ContainerId = "",
  [string]$Host = "72.62.104.184",
  [string]$User = "root"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$Key = Join-Path $Root ".vps-migrate-key"
$SshArgs = @("-i", $Key, "-o", "StrictHostKeyChecking=no", "${User}@${Host}")

if (-not (Test-Path $Key)) {
  Write-Error "Chave $Key ausente. Rode ssh-keygen ou peça ao agente para gerar."
}

function Invoke-RemoteScript([string]$LocalScript) {
  Get-Content $LocalScript -Raw | & ssh @SshArgs "bash -s"
}

switch ($Phase) {
  "discover" {
    Invoke-RemoteScript (Join-Path $PSScriptRoot "01-discover-databases.sh")
  }
  "migrate" {
    if (-not $ContainerId) { Write-Error "Passe -ContainerId do discovery" }
    Write-Host "Criando pasta remota e enviando migrations..."
    & ssh @SshArgs "${User}@${Host}" "mkdir -p /tmp/iasarai-migrations"
    & scp @SshArgs -r (Join-Path $Root "migrations") "${User}@${Host}:/tmp/iasarai-migrations/"
    & scp @SshArgs (Join-Path $PSScriptRoot "02-run-migrations.sh") "${User}@${Host}:/tmp/02-run-migrations.sh"
    & ssh @SshArgs "${User}@${Host}" "sed -i 's/\r$//' /tmp/02-run-migrations.sh"
    $cmd = "export IASARAI_DB_CONTAINER=$ContainerId MIGRATE_CONFIRM=yes-iasarai-db MIGRATIONS_DIR=/tmp/iasarai-migrations; bash /tmp/02-run-migrations.sh"
    & ssh @SshArgs $cmd
  }
}
