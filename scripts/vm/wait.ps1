# scripts/vm/wait.ps1 —— 等 send.ps1 写出结果，然后把结果以 base64 打到 stdout（宿主解析）
# 参数：-Path 结果文件 -TimeoutSec 最多等多久
param(
  [string]$Path = 'C:\Temp\wc-result.json',
  [int]$TimeoutSec = 75
)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $Path) {
    Start-Sleep -Milliseconds 150          # 让写盘落定
    try {
      $b = [Convert]::ToBase64String([IO.File]::ReadAllBytes($Path))
      'RJ=' + $b
      exit 0
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  Start-Sleep -Milliseconds 400
}
'NONE'
exit 1
