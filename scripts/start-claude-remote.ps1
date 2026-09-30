$ErrorActionPreference = "Stop"

$projectRoot = Join-Path (Split-Path -Parent $PSScriptRoot) ".appbuilder\projects"
if (-not (Test-Path -LiteralPath $projectRoot -PathType Container)) {
  throw "No existe la carpeta de proyectos de AppBuilder: $projectRoot"
}

$claude = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue
if (-not $claude) {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "Machine")
  $claude = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue
}
if (-not $claude) {
  throw "Instala Claude Code desde https://code.claude.com/docs/en/setup antes de continuar."
}

# Claude Code gives API keys priority over the personal subscription.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue

Push-Location -LiteralPath $projectRoot
try {
  & $claude.Source --remote-control "AppBuilder"
} finally {
  Pop-Location
}
