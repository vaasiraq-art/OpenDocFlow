param(
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
$AgentsSkills = Join-Path $HOME '.agents\skills'

function Copy-SkillSet([string]$Source, [string]$Destination) {
    if (-not (Test-Path $Source)) { return }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem $Source -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $target = Join-Path $Destination $_.Name
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        Copy-Item -Path (Join-Path $_.FullName '*') -Destination $target -Recurse -Force
    }
}

Write-Host "Snapshotting the current OpenCode setup into:" -ForegroundColor Green
Write-Host $SetupRoot

if ($DryRun) {
    Write-Host "Dry run only. No files will be written."
}

$files = @('AGENTS.md', 'cli.json', 'package.json', 'package-lock.json')
foreach ($file in $files) {
    $src = Join-Path $ConfigDir $file
    if (Test-Path $src) {
        if ($DryRun) {
            Write-Host "Would copy $file"
        } else {
            Copy-Item $src (Join-Path $ConfigSrc $file) -Force
        }
    }
}

function ConvertFrom-Jsonc([string]$RawText) {
    $clean = [regex]::Replace($RawText, '(?m)^\s*//.*$', '')
    $clean = [regex]::Replace($clean, '/\*[\s\S]*?\*/', '')
    return ($clean | ConvertFrom-Json)
}

$cfgFile = Join-Path $ConfigDir 'opencode.jsonc'
if (Test-Path $cfgFile) {
    if ($DryRun) {
        Write-Host "Would copy portable opencode.jsonc"
    } else {
        try {
            $cfgObj = ConvertFrom-Jsonc (Get-Content $cfgFile -Raw)
            if ($cfgObj.PSObject.Properties['mcp']) {
                foreach ($localMcp in @('rea', 'opendocflow')) {
                    if ($cfgObj.mcp.PSObject.Properties[$localMcp]) {
                        $cfgObj.mcp.PSObject.Properties.Remove($localMcp)
                    }
                }
                if (($cfgObj.mcp.PSObject.Properties | Measure-Object).Count -eq 0) {
                    $cfgObj.PSObject.Properties.Remove('mcp')
                }
            }
            if ($cfgObj.PSObject.Properties['providers']) {
                # Strip local file-key paths from portable snapshot
                $cfgObj.PSObject.Properties.Remove('providers')
            }
            ($cfgObj | ConvertTo-Json -Depth 10) | Set-Content -Path (Join-Path $ConfigSrc 'opencode.jsonc') -Encoding utf8
        } catch {
            Write-Warning "Could not sanitize opencode.jsonc; writing clean schema stub."
            '{ "$schema": "https://opencode.ai/config.json" }' | Set-Content -Path (Join-Path $ConfigSrc 'opencode.jsonc') -Encoding utf8
        }
    }
}

$memorySrc = Join-Path $ConfigDir 'memory'
$memoryDst = Join-Path $ConfigSrc 'memory'
if (Test-Path $memorySrc) {
    if ($DryRun) {
        Write-Host "Would copy global memory blocks"
    } else {
        New-Item -ItemType Directory -Force -Path $memoryDst | Out-Null
        Copy-Item (Join-Path $memorySrc '*') $memoryDst -Force
    }
}

if ($DryRun) {
    Write-Host "Would copy global skills and Vercel/REA skills"
} else {
    Copy-SkillSet (Join-Path $ConfigDir 'skills') (Join-Path $ConfigSrc 'skills')
    Copy-SkillSet $AgentsSkills (Join-Path $ConfigSrc 'agents-skills')
}

$projectPlugin = Join-Path (Get-Location) '.opencode\plugins\graphify.js'
if (Test-Path $projectPlugin) {
    if ($DryRun) {
        Write-Host "Would copy the Graphify project hook"
    } else {
        Copy-Item $projectPlugin (Join-Path $ConfigSrc 'plugins\graphify.js') -Force
    }
}

Write-Host "Snapshot complete." -ForegroundColor Green
Write-Host "Review config\memory before sharing this folder; it contains personal preferences."
