param(
    [switch]$Yes,
    [switch]$DryRun,
    [switch]$SkipSkillsCli,
    [switch]$SkipGraphify,
    [switch]$SkipRea
)

$ErrorActionPreference = 'Stop'
$SetupRoot = Split-Path -Parent $PSScriptRoot
$ConfigSrc = Join-Path $SetupRoot 'config'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if ($env:OPENCODE_CONFIG_DIR) {
    $ConfigDir = $env:OPENCODE_CONFIG_DIR
} elseif ($env:XDG_CONFIG_HOME) {
    $ConfigDir = Join-Path $env:XDG_CONFIG_HOME 'opencode'
} else {
    $ConfigDir = Join-Path $HOME '.config\opencode'
}
$AgentsSkills = Join-Path $HOME '.agents\skills'

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Get-CommandPath([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Copy-SkillSet([string]$Source, [string]$Destination) {
    if (-not (Test-Path $Source)) { return }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem $Source -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $target = Join-Path $Destination $_.Name
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        Copy-Item -Path (Join-Path $_.FullName '*') -Destination $target -Recurse -Force
    }
}

Write-Host "OpenCode setup restore" -ForegroundColor Green
Write-Host "Source: $SetupRoot"
Write-Host "Config: $ConfigDir"
Write-Host "Skills: $AgentsSkills"

$OpenCode = Get-CommandPath 'opencode'
if (-not $OpenCode) {
    Write-Host "OpenCode is not installed or not on PATH." -ForegroundColor Red
    Write-Host "Install OpenCode first, then run this script again."
    exit 1
}

$Node = Get-CommandPath 'node'
if ($Node) {
    $nodeVersion = (& node --version).TrimStart('v')
    Write-Host "Node: $nodeVersion"
    try {
        if ([version]$nodeVersion -lt [version]'22.20.0') {
            Write-Warning "The skills CLI needs Node 22.20+. Current: $nodeVersion"
        }
    } catch { }
} else {
    Write-Warning "Node.js was not found. The skills CLI and REA will be unavailable."
}

if (-not $DryRun -and -not $Yes) {
    Write-Host ""
    Write-Host "This will back up and replace the OpenCode config, memory, plugins and skills."
    $answer = Read-Host "Continue? [y/N]"
    if ($answer -notmatch '^[yY]') {
        Write-Host "Cancelled."
        exit 0
    }
}

Write-Step "Creating a backup"
if (Test-Path $ConfigDir) {
    $BackupDir = Join-Path $ConfigDir "backup-$Stamp"
    if ($DryRun) {
        Write-Host "Would back up to $BackupDir"
    } else {
        New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
        foreach ($item in @('opencode.jsonc', 'AGENTS.md', 'cli.json', 'package.json', 'package-lock.json', 'memory', 'skills')) {
            $src = Join-Path $ConfigDir $item
            if (Test-Path $src) {
                Copy-Item $src (Join-Path $BackupDir $item) -Recurse -Force
            }
        }
        Write-Host "Backup: $BackupDir"
    }
} else {
    if ($DryRun) {
        Write-Host "Would create $ConfigDir"
    } else {
        New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    }
}

Write-Step "Installing OpenCode plugins"
$plugins = @()
try {
    $snapshotConfig = Get-Content (Join-Path $ConfigSrc 'opencode.jsonc') -Raw | ConvertFrom-Json
    if ($snapshotConfig.plugins) {
        foreach ($entry in $snapshotConfig.plugins) {
            if ($entry -is [string]) {
                $plugins += $entry
            } elseif ($entry.package) {
                $plugins += $entry.package
            }
        }
    }
} catch {
    Write-Warning "Could not parse the snapshot plugin list; using defaults."
}
if ($plugins.Count -eq 0) {
    $plugins = @(
        'opencode-agent-memory@0.3.0',
        'cc-safety-net@2.6.19'
    )
}
if ($DryRun) {
    foreach ($plugin in $plugins) {
        Write-Host "Would run: opencode plugin add $plugin"
    }
} else {
    @'
{
  "$schema": "https://opencode.ai/config.json"
}
'@ | Set-Content -Path (Join-Path $ConfigDir 'opencode.jsonc') -Encoding utf8

    foreach ($plugin in $plugins) {
        Write-Host "Adding $plugin"
        & $OpenCode plugin add $plugin
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not add $plugin (exit $LASTEXITCODE)."
        }
    }
}

Write-Step "Restoring config, memory and skills"
$files = @('opencode.jsonc', 'AGENTS.md', 'cli.json', 'package.json', 'package-lock.json')
foreach ($file in $files) {
    $src = Join-Path $ConfigSrc $file
    if (Test-Path $src) {
        if ($DryRun) {
            Write-Host "Would copy $file"
        } else {
            Copy-Item $src (Join-Path $ConfigDir $file) -Force
        }
    }
}

$memorySrc = Join-Path $ConfigSrc 'memory'
$memoryDst = Join-Path $ConfigDir 'memory'
if (Test-Path $memorySrc) {
    if ($DryRun) {
        Write-Host "Would copy memory blocks"
    } else {
        New-Item -ItemType Directory -Force -Path $memoryDst | Out-Null
        Copy-Item (Join-Path $memorySrc '*') $memoryDst -Force
    }
}

if ($DryRun) {
    Write-Host "Would copy global Graphify skill, REA skill, and Vercel skills"
} else {
    Copy-SkillSet (Join-Path $ConfigSrc 'skills') (Join-Path $ConfigDir 'skills')
    Copy-SkillSet (Join-Path $ConfigSrc 'agents-skills') $AgentsSkills
}

Write-Step "Installing the skills CLI"
if ($SkipSkillsCli) {
    Write-Host "Skipped."
} elseif (-not (Get-CommandPath 'npm')) {
    Write-Warning "npm was not found; skipped the skills CLI."
} elseif ($DryRun) {
    Write-Host "Would run: npm install --prefix $ConfigDir --no-audit --no-fund"
} else {
    & npm install --prefix $ConfigDir --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "npm install failed (exit $LASTEXITCODE)."
    }
}

Write-Step "Installing Graphify"
if ($SkipGraphify) {
    Write-Host "Skipped."
} else {
    $uv = Get-CommandPath 'uv'
    if (-not $uv) {
        Write-Warning "uv was not found. Install Python 3.10+ and uv, then run: uv tool install graphifyy"
    } elseif ($DryRun) {
        Write-Host "Would run: uv tool install graphifyy"
    } else {
        & uv tool install graphifyy
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Graphify install failed (exit $LASTEXITCODE)."
        }
    }
}

Write-Step "Installing & registering REA 6.8.0 MCP"
if ($SkipRea) {
    Write-Host "Skipped."
} elseif (-not (Get-CommandPath 'npm')) {
    Write-Warning "npm was not found; skipped REA."
} elseif ($DryRun) {
    Write-Host "Would install rea-agents@6.8.0 and register REA MCP in opencode.jsonc"
} else {
    $reaPrefix = Join-Path $ConfigDir 'tools\rea'
    New-Item -ItemType Directory -Force -Path $reaPrefix | Out-Null
    & npm install --prefix $reaPrefix rea-agents@6.8.0 --no-audit --no-fund
    $reaScript = Join-Path $reaPrefix 'node_modules\rea-agents\scripts\rea.mjs'
    if ((Test-Path $reaScript) -and $Node) {
        $cfgPath = Join-Path $ConfigDir 'opencode.jsonc'
        $cfgObj = Get-Content $cfgPath -Raw | ConvertFrom-Json
        if (-not $cfgObj.PSObject.Properties['mcp']) {
            $cfgObj | Add-Member -NotePropertyName 'mcp' -NotePropertyValue ([pscustomobject]@{})
        }
        $reaEntry = [pscustomobject]@{
            type    = 'local'
            command = @($Node, $reaScript, 'mcp')
            enabled = $true
        }
        $cfgObj.mcp | Add-Member -NotePropertyName 'rea' -NotePropertyValue $reaEntry -Force
        ($cfgObj | ConvertTo-Json -Depth 10) | Set-Content -Path $cfgPath -Encoding utf8
        Write-Host "Registered REA 6.8.0 MCP server."
    } else {
        Write-Warning "REA script was not found after install."
    }
}

Write-Step "Verifying"
if (-not $DryRun) {
    Write-Host "--- plugins ---"
    & $OpenCode plugin list
    $SkillsCmd = Join-Path $ConfigDir 'node_modules\.bin\skills.cmd'
    if (Test-Path $SkillsCmd) {
        Write-Host "--- global skills ---"
        & $SkillsCmd list -g -a opencode
    }
    $Graphify = Get-CommandPath 'graphify'
    if ($Graphify) {
        Write-Host "--- graphify ---"
        & graphify --version
    }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Restart OpenCode once. Then use new-project.bat for each new project."
Write-Host "For Graphify, run inside a project: graphify ."
