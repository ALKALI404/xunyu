# scripts/vm/client-send.ps1 —— 宿主 vm-sender.mjs 在 VM 侧用的"客户端"：
# 读 C:\Temp\wc-httpjob.json {conv,text} → POST 到常驻 watcher(127.0.0.1:8766/send) → 把响应 base64 打出来
# 为什么要走这一层：宿主经 SSH 只能跑命令行，中文参数在 cmd 里会被转码；用文件传参 + base64 回传最稳。
param(
  [string]$JobPath = 'C:\Temp\wc-httpjob.json',
  [string]$Url = 'http://127.0.0.1:8766/send',
  [int]$TimeoutSec = 60
)
$ErrorActionPreference = 'Continue'
try {
  $raw = [IO.File]::ReadAllText($JobPath, [Text.Encoding]::UTF8)
  $job = $raw | ConvertFrom-Json
  $body = @{ conv = [string]$job.conv; text = [string]$job.text } | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -Method POST -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec $TimeoutSec
  $out = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$resp.Content))
  [IO.File]::WriteAllText('C:\Temp\wc-httpresult.txt', 'RESP=' + $out, [Text.UTF8Encoding]::new($false))
  exit 0
} catch {
  $msg = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message))
  [IO.File]::WriteAllText('C:\Temp\wc-httpresult.txt', 'ERR=' + $msg, [Text.UTF8Encoding]::new($false))
  exit 1
}
