# 从 GitHub Releases (dev-latest) 下载云端编译产物并替换本地客户端
$ErrorActionPreference = 'Stop'

$targetDir = "C:\Users\jxc\AppData\Local\Cockpit Tools"
$targetMainExe = Join-Path $targetDir "cockpit-tools.exe"
$downloadUrl = "https://github.com/qmxqw/cockpit-tools/releases/download/dev-latest/cockpit-tools-dev-windows-x64.exe"
$tempExe = Join-Path $env:TEMP "cockpit-tools-cloud-latest.exe"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " ☁️ 从 GitHub 云端拉取最新编译版" -ForegroundColor Cyan
Write-Host " 目标文件: $downloadUrl" -ForegroundColor Gray
Write-Host "==========================================" -ForegroundColor Cyan

Write-Host "[1/4] 正在下载最新云端构建产物..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempExe -UseBasicParsing
    $fileSize = (Get-Item $tempExe).Length / 1MB
    Write-Host "[OK] 下载完成，大小: $([Math]::Round($fileSize, 2)) MB" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] 下载失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[TIP] 请确认 GitHub Actions 的 dev-auto-build 工作流已执行完成。" -ForegroundColor Yellow
    exit 1
}

Write-Host "[2/4] 关闭本地运行中的进程..." -ForegroundColor Yellow
Get-Process cockpit-tools -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "*msedgewebview2*" -and $_.CommandLine -like "*com.jlcodes.cockpit-tools*"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

Write-Host "[3/4] 替换本地可执行文件..." -ForegroundColor Yellow
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}
Copy-Item -Path $tempExe -Destination $targetMainExe -Force
Remove-Item -Path $tempExe -Force -ErrorAction SilentlyContinue
Write-Host "[OK] 已成功更新至: $targetMainExe" -ForegroundColor Green

Write-Host "[4/4] 启动新版本客户端..." -ForegroundColor Yellow
& explorer.exe $targetMainExe
Write-Host "==========================================" -ForegroundColor Green
Write-Host " 🎉 更新完成！客户端已在后台启动。" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
