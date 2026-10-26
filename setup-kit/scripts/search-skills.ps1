param(
    [Parameter(Position = 0)]
    [string]$Query
)

$ErrorActionPreference = 'Stop'

if ($env:OPENCODE_CONFIG_DIR) {
    $ConfigDir = $env:OPENCODE_CONFIG_DIR
} elseif ($env:XDG_CONFIG_HOME) {
    $ConfigDir = Join-Path $env:XDG_CONFIG_HOME 'opencode'
} else {
    $ConfigDir = Join-Path $HOME '.config\opencode'
}

if (-not $Query) {
    $Query = Read-Host "Search skills for (e.g. godot, react, testing)"
}
if (-not $Query) {
    Write-Host "No query entered."
    exit 0
}

$skillsCmd = Join-Path $ConfigDir 'node_modules\.bin\skills.cmd'
if (Test-Path $skillsCmd) {
    & $skillsCmd find $Query
} else {
    npx -y skills@1.7.4 find $Query
}
