param(
    [string]$Version = '6.8.0',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if ($env:OPENCODE_CONFIG_DIR) {
    $ConfigDir = $env:OPENCODE_CONFIG_DIR
} elseif ($env:XDG_CONFIG_HOME) {
    $ConfigDir = Join-Path $env:XDG_CONFIG_HOME 'opencode'
} else {
    $ConfigDir = Join-Path $HOME '.config\opencode'
}
$ConfigFile = Join-Path $ConfigDir 'opencode.jsonc'

Write-Host "Installing REA $Version for OpenCode..." -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "Would install the REA skill and add the MCP registration to $ConfigFile"
    exit 0
}

# Install the matching REA skill globally for OpenCode.
$skillsCmd = Join-Path $ConfigDir 'node_modules\.bin\skills.cmd'
if (Test-Path $skillsCmd) {
    & $skillsCmd add morluto/rea --skill reverse-engineer-anything -g -a opencode -y --copy
} else {
    npx -y skills@1.7.4 add morluto/rea --skill reverse-engineer-anything -g -a opencode -y --copy
}
if ($LASTEXITCODE -ne 0) {
    Write-Warning "The REA skill install returned exit code $LASTEXITCODE."
}

# Add a portable MCP launcher. npx is resolved at runtime, so this works even
# when the OpenCode config folder moves to another PC.
$config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
if (-not $config.mcp) {
    $config | Add-Member -NotePropertyName mcp -NotePropertyValue ([pscustomobject]@{}) -Force
}
$rea = [pscustomobject]@{
    type    = 'local'
    command = @('cmd.exe', '/d', '/c', 'npx', '-y', "rea-agents@$Version", 'mcp')
    enabled = $true
}
$config.mcp | Add-Member -NotePropertyName rea -NotePropertyValue $rea -Force
$config | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigFile -Encoding utf8

Write-Host "REA MCP registration written to $ConfigFile"
Write-Host "Restart OpenCode to load the REA tools."
