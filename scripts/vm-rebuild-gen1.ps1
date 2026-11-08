# 重建为 Gen1（BIOS 引导）——LTSC 2019 从 ISO 引导最稳
# 管理员 PowerShell 运行：
#   powershell -ExecutionPolicy Bypass -File E:\DSH_workspace\scripts\vm-rebuild-gen1.ps1
$ErrorActionPreference = 'Stop'
$VmName = 'XunyuWeCom'
$Root   = 'E:\VM'
$Iso    = 'E:\VM\iso\LTSC2019.iso'
$Switch = 'XunyuExt'
$Vhdx   = Join-Path $Root "$VmName\Virtual Hard Disks\$VmName.vhdx"

if (-not (Test-Path $Iso)) { throw "ISO 不存在：$Iso" }

Write-Host '== 清理旧 VM（保留磁盘文件以便复用）==' -ForegroundColor Cyan
$vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
if ($vm) {
  if ($vm.State -ne 'Off') { Stop-VM -Name $VmName -TurnOff -Force }
  Remove-VM -Name $VmName -Force
  Write-Host '已移除旧 VM 定义'
}

Write-Host '== 建 Gen1 VM ==' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Split-Path $Vhdx -Parent) | Out-Null
New-VM -Name $VmName -Generation 1 -MemoryStartupBytes 8GB -Path $Root -SwitchName $Switch | Out-Null
Set-VM -Name $VmName -ProcessorCount 4 -StaticMemory
Set-VMMemory -VMName $VmName -StartupBytes 8GB -DynamicMemoryEnabled $false

if (-not (Test-Path $Vhdx)) {
  New-VHD -Path $Vhdx -SizeBytes 100GB -Dynamic | Out-Null
}
Add-VMHardDiskDrive -VMName $VmName -Path $Vhdx
Add-VMDvdDrive -VMName $VmName -Path $Iso

Write-Host '== BIOS 引导顺序：光驱优先 ==' -ForegroundColor Cyan
Set-VMBios -VMName $VmName -StartupOrder @('CD', 'IDE', 'LegacyNetworkAdapter', 'Floppy')

Write-Host '== 启动 + 打开控制台 ==' -ForegroundColor Cyan
Start-VM -Name $VmName
Start-Sleep -Seconds 2
Start-Process 'vmconnect.exe' -ArgumentList 'localhost', $VmName

Write-Host ''
Write-Host '接下来（在虚拟机窗口里）：' -ForegroundColor Yellow
Write-Host '  1) 看到 "Press any key to boot from CD or DVD" 立刻按空格'
Write-Host '  2) 语言→下一步→现在安装→我没有产品密钥→Windows 10 企业版 LTSC→自定义'
Write-Host '  3) 选 100GB 未分配空间→下一步（自动分区）'
Write-Host '  4) 进桌面后设本地账号，然后叫鲟鱼'
Write-Host ''
Get-VM -Name $VmName | Select-Object Name, State, Generation, ProcessorCount, @{n='MemGB'; e={ [math]::Round($_.MemoryStartup/1GB,1) }} | Format-List
