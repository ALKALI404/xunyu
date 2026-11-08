# 一次性：建 Hyper-V 虚拟机跑企微（需管理员运行）
#
# 用法（管理员 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File E:\DSH_workspace\scripts\vm-provision.ps1
#
# 做完后：
#   - 把当前用户加进 Hyper-V Administrators（之后本体/工具无需再提权就能管 VM）
#   - 建外部交换机 XunyuExt（用当前活动的有线/无线网卡）
#   - 建 VM XunyuWeCom：Gen2 / 4 vCPU / 静态 8GB / 100GB 动态盘在 E:\VM / 挂 LTSC ISO
#   - 设置 VM 自动启动（随宿主启动，延迟 30 秒）
# 幂等：已存在的对象会跳过。

$ErrorActionPreference = 'Stop'
$VmName   = 'XunyuWeCom'
$VmRoot   = 'E:\VM'
$VhdxPath = Join-Path $VmRoot "$VmName\Virtual Hard Disks\$VmName.vhdx"
$IsoPath  = 'D:\迅雷下载\cn_windows_10_enterprise_ltsc_2019_x64_dvd_9c09ff24.iso'
$Switch   = 'XunyuExt'
$MemGB    = 8
$CpuCount = 4
$DiskGB   = 100

Write-Host "== 0/5 检查环境 ==" -ForegroundColor Cyan
if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V PowerShell 模块不可用，请先启用 Hyper-V 并重启' }
if (-not (Test-Path $IsoPath)) { throw "ISO 不存在：$IsoPath" }

Write-Host "== 1/5 Hyper-V Administrators 组 ==" -ForegroundColor Cyan
$grp = 'Hyper-V Administrators'
if (-not (Get-LocalGroup -Name $grp -ErrorAction SilentlyContinue)) {
  Write-Warning "找不到组 $grp（系统语言不同？），跳过"
} else {
  $me = "$env:USERDOMAIN\$env:USERNAME"
  $in = Get-LocalGroupMember -Group $grp -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $me }
  if ($in) { Write-Host "已在组内：$me" } else { Add-LocalGroupMember -Group $grp -Member $me; Write-Host "已加入 $grp：$me（需重新登录生效）" }
}

Write-Host "== 2/5 外部交换机 ==" -ForegroundColor Cyan
if (Get-VMSwitch -Name $Switch -ErrorAction SilentlyContinue) {
  Write-Host "交换机已存在：$Switch"
} else {
  $nic = (Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Sort-Object -Property ifIndex | Select-Object -First 1)
  if (-not $nic) { throw '找不到已连接的网络适配器' }
  Write-Host "用网卡：$($nic.Name) / $($nic.InterfaceDescription)"
  New-VMSwitch -Name $Switch -NetAdapterName $nic.Name -AllowManagementOS $true | Out-Null
  Write-Host "已建交换机：$Switch"
}

Write-Host "== 3/5 虚拟机 ==" -ForegroundColor Cyan
if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) {
  Write-Host "VM 已存在：$VmName"
} else {
  New-Item -ItemType Directory -Force -Path $VmRoot | Out-Null
  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ([int64]$MemGB * 1GB) -Path $VmRoot -SwitchName $Switch | Out-Null
  Set-VM -Name $VmName -ProcessorCount $CpuCount -StaticMemory -AutomaticStartAction StartIfRunning -AutomaticStopAction Save
  Set-VMMemory -VMName $VmName -StartupBytes ([int64]$MemGB * 1GB) -DynamicMemoryEnabled $false
  New-Item -ItemType Directory -Force -Path (Split-Path $VhdxPath -Parent) | Out-Null
  New-VHD -Path $VhdxPath -SizeBytes ([int64]$DiskGB * 1GB) -Dynamic | Out-Null
  Add-VMHardDiskDrive -VMName $VmName -Path $VhdxPath
  Set-VMFirmware -VMName $VmName -EnableSecureBoot Off
  Add-VMDvdDrive -VMName $VmName -Path $IsoPath
  $dvd = Get-VMDvdDrive -VMName $VmName
  Set-VMFirmware -VMName $VmName -FirstBootDevice $dvd
  Write-Host "已建 VM：$VmName（$CpuCount vCPU / ${MemGB}GB / ${DiskGB}GB）"
}

Write-Host "== 4/5 自动启动（宿主开机延迟 30 秒启动 VM）==" -ForegroundColor Cyan
Set-VM -Name $VmName -AutomaticStartDelay 30 -AutomaticStartAction StartIfRunning

Write-Host "== 5/5 结果 ==" -ForegroundColor Cyan
Get-VM -Name $VmName | Select-Object Name, State, ProcessorCount, @{n='MemGB'; e={ [math]::Round($_.MemoryStartup / 1GB, 1) }}, AutomaticStartAction, AutomaticStartDelay | Format-List
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "  1) 启动 VM： Start-VM -Name $VmName"
Write-Host "  2) 打开控制台： vmconnect.exe localhost $VmName    ← 装系统期间保持这个窗口开着"
Write-Host "  3) 装完 LTSC + 企微客户端后，叫主人扫码登录"
Write-Host "  4) 装好立刻打检查点： Checkpoint-VM -Name $VmName -SnapshotName '装好-企微已登录'"
