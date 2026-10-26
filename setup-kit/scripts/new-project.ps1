param(
    [Parameter(Position = 0)]
    [string]$Path,
    [Parameter(Position = 1)]
    [string]$Name,
    [string]$SkillQuery,
    [switch]$NoSearch,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$SetupRoot = Split-Path -Parent $PSScriptRoot
$ConfigSrc = Join-Path $SetupRoot 'config'

if ($env:OPENCODE_CONFIG_DIR) {
    $ConfigDir = $env:OPENCODE_CONFIG_DIR
} elseif ($env:XDG_CONFIG_HOME) {
    $ConfigDir = Join-Path $env:XDG_CONFIG_HOME 'opencode'
} else {
    $ConfigDir = Join-Path $HOME '.config\opencode'
}

if (-not $Path) {
    $Path = Read-Host "Project folder (blank = current folder)"
    if (-not $Path) { $Path = (Get-Location).Path }
}
$Path = [System.IO.Path]::GetFullPath($Path)

if (-not $Name) {
    $Name = Split-Path $Path -Leaf
    if (-not $Name) { $Name = 'project' }
}

Write-Host "New project: $Name" -ForegroundColor Green
Write-Host "Folder: $Path"

if ($DryRun) {
    Write-Host "Would create $Path and .opencode scaffolding."
} else {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Path '.opencode\plugins') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $Path '.opencode\skills') | Out-Null

    $graphifyPlugin = Join-Path $ConfigSrc 'plugins\graphify.js'
    if (Test-Path $graphifyPlugin) {
        Copy-Item $graphifyPlugin (Join-Path $Path '.opencode\plugins\graphify.js') -Force
        Write-Host "Copied Graphify project hook."
    }

    $autoSwitchPlugin = Join-Path $ConfigSrc 'plugins\free-model-autoswitch.js'
    if (Test-Path $autoSwitchPlugin) {
        Copy-Item $autoSwitchPlugin (Join-Path $Path '.opencode\plugins\free-model-autoswitch.js') -Force
        Write-Host "Copied Free Model Auto-Fallback plugin."
    }

    $readme = Join-Path $Path 'README.md'
    if (-not (Test-Path $readme)) {
        @"
# $Name

Created with the OpenCode project starter.

## Run

Add the exact run command here once the app is built.

## Notes

- Keep dependencies local to this project.
- Keep secrets in .env and never commit them.
"@ | Set-Content -Path $readme -Encoding utf8
    }
}

if ($NoSearch) {
    Write-Host "Skill search skipped."
} else {
    if (-not $SkillQuery) {
        $SkillQuery = Read-Host "Search skills for this project (blank = skip)"
    }

    if ($SkillQuery) {
        $skillsCmd = Join-Path $ConfigDir 'node_modules\.bin\skills.cmd'
        Write-Host ""
        Write-Host "Searching skills for: $SkillQuery" -ForegroundColor Cyan
        if ($DryRun) {
            Write-Host "Would run: skills find $SkillQuery"
        } elseif (Test-Path $skillsCmd) {
            & $skillsCmd find $SkillQuery
        } else {
            npx -y skills@1.7.4 find $SkillQuery
        }
    } else {
        Write-Host "No skill search requested."
    }
}

Write-Host ""
Write-Host "Project ready: $Path"
Write-Host "Next: cd `"$Path`" and start OpenCode."
Write-Host "For Graphify: graphify ."
