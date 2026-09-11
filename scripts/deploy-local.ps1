param (
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$targetDir = "C:\Users\jxc\AppData\Local\Cockpit Tools"
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$targetMainExe = Join-Path $targetDir "cockpit-tools.exe"
$targetSidecarExe = Join-Path $targetDir "cockpit-cliproxy.exe"

if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

function Stop-AppProcesses {
    param([string[]]$Names)
    foreach ($name in $Names) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host "[STOP] Stopping running process: $($_.ProcessName) (PID $($_.Id))..." -ForegroundColor Yellow
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
    # 彻底清理残留的 WebView2 孤儿进程，避免占用 EBWebView\lockfile 导致 0x800700AA 崩溃
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -like "*msedgewebview2*" -and $_.CommandLine -like "*com.jlcodes.cockpit-tools*"
    } | ForEach-Object {
        Write-Host "[STOP] Stopping orphaned WebView2 process: $($_.ProcessId)..." -ForegroundColor Yellow
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# 1. Check if Go Sidecar needs building
$needBuildSidecar = $Force.IsPresent
if (-not $needBuildSidecar) {
    if (-not (Test-Path $targetSidecarExe)) {
        $needBuildSidecar = $true
    } else {
        $targetSidecarTime = (Get-Item $targetSidecarExe).LastWriteTime
        $goFiles = Get-ChildItem -Path (Join-Path $repoRoot "sidecars\cockpit-cliproxy") -Recurse -File |
            Where-Object { $_.FullName -notmatch '\\bin\\' }
        $latestGoTime = ($goFiles | Measure-Object -Property LastWriteTime -Maximum).Maximum
        if ($latestGoTime -and ($latestGoTime -gt $targetSidecarTime)) {
            $needBuildSidecar = $true
        }
    }
}

# 2. Check if Main app (Rust + UI) needs building
$needBuildMain = $Force.IsPresent
if (-not $needBuildMain) {
    if (-not (Test-Path $targetMainExe)) {
        $needBuildMain = $true
    } else {
        $targetMainTime = (Get-Item $targetMainExe).LastWriteTime
        $watchPaths = @(
            (Join-Path $repoRoot "src"),
            (Join-Path $repoRoot "src-tauri\src"),
            (Join-Path $repoRoot "src-tauri\Cargo.toml"),
            (Join-Path $repoRoot "src-tauri\tauri.conf.json"),
            (Join-Path $repoRoot "package.json"),
            (Join-Path $repoRoot "vite.config.ts"),
            (Join-Path $repoRoot "index.html")
        )
        $latestMainTime = $null
        foreach ($wp in $watchPaths) {
            if (Test-Path $wp) {
                if ((Get-Item $wp).PSIsContainer) {
                    $files = Get-ChildItem -Path $wp -Recurse -File -ErrorAction SilentlyContinue
                    $max = ($files | Measure-Object -Property LastWriteTime -Maximum).Maximum
                    if ($max -and ($null -eq $latestMainTime -or $max -gt $latestMainTime)) {
                        $latestMainTime = $max
                    }
                } else {
                    $itemTime = (Get-Item $wp).LastWriteTime
                    if ($null -eq $latestMainTime -or $itemTime -gt $latestMainTime) {
                        $latestMainTime = $itemTime
                    }
                }
            }
        }
        if ($latestMainTime -and ($latestMainTime -gt $targetMainTime)) {
            $needBuildMain = $true
        }
    }
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Incremental Build & Deploy Detection:" -ForegroundColor Cyan
$sidecarStatus = if ($needBuildSidecar) { "BUILD NEEDED [YES]" } else { "UP TO DATE [SKIP]" }
$mainStatus    = if ($needBuildMain)    { "BUILD NEEDED [YES]" } else { "UP TO DATE [SKIP]" }
$sidecarColor  = if ($needBuildSidecar) { 'Yellow' } else { 'Green' }
$mainColor     = if ($needBuildMain)    { 'Yellow' } else { 'Green' }
Write-Host "   - cockpit-cliproxy.exe (Go Sidecar) : $sidecarStatus" -ForegroundColor $sidecarColor
Write-Host "   - cockpit-tools.exe    (Main App)   : $mainStatus" -ForegroundColor $mainColor
Write-Host "==========================================" -ForegroundColor Cyan

if (-not $needBuildSidecar -and -not $needBuildMain) {
    Write-Host "[OK] All components are up-to-date. No build needed." -ForegroundColor Green
    Write-Host "[TIP] To force rebuild, run: npm run build:deploy -- -Force" -ForegroundColor Gray
    exit 0
}

# 3. Build & Deploy Go Sidecar (typically ~1-2 seconds)
if ($needBuildSidecar) {
    Write-Host "[BUILD] Compiling Go Sidecar (cockpit-cliproxy)..." -ForegroundColor Cyan
    Stop-AppProcesses @("cockpit-cliproxy")
    $sidecarDir = Join-Path $repoRoot "sidecars\cockpit-cliproxy"
    Push-Location $sidecarDir
    try {
        $env:CGO_ENABLED = "0"
        go build -trimpath -ldflags "-s -w" -o $targetSidecarExe .
        if ($LASTEXITCODE -ne 0) {
            throw "Go build failed with status $LASTEXITCODE"
        }
        $cachedSidecarDir = Join-Path $repoRoot "target\release"
        if (Test-Path $cachedSidecarDir) {
            Copy-Item -Path $targetSidecarExe -Destination (Join-Path $cachedSidecarDir "cockpit-cliproxy.exe") -Force
        }
        Write-Host "[OK] Go Sidecar updated successfully: $targetSidecarExe" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

# 4. Build & Deploy Main app (skip bundles)
if ($needBuildMain) {
    Write-Host "[BUILD] Compiling Main App (skipping installers)..." -ForegroundColor Cyan
    Stop-AppProcesses @("cockpit-tools")
    Push-Location $repoRoot
    try {
        $env:COCKPIT_SKIP_CLIPROXY_BUILD = "1"
        npx tauri build --ci --no-sign --config src-tauri/tauri.ci.conf.json --no-bundle
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri build failed with status $LASTEXITCODE"
        }
        $sourceExe = Join-Path $repoRoot "target\release\cockpit-tools.exe"
        if (Test-Path $sourceExe) {
            Copy-Item -Path $sourceExe -Destination $targetMainExe -Force
            Write-Host "[OK] Main app updated successfully: $targetMainExe" -ForegroundColor Green
        } else {
            throw "Built binary not found: $sourceExe"
        }
    } finally {
        Pop-Location
    }
}

Write-Host "[DONE] Deployment completed! Output directory: $targetDir" -ForegroundColor Green
