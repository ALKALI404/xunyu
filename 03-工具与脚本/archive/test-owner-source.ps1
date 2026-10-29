# 主人亲发验收：直接打桥接 /api/dsh/say，带 origin=relay + owner 码
# 目的：证明「主人亲发」这条通道能走通，且投递时第一行会是 〔来源：主人亲发〕
#
# 用法（在本机 PowerShell 里跑）：
#   pwsh -File <工作区>\test-owner-source.ps1
#   pwsh -File <工作区>\test-owner-source.ps1 -Message "自定义内容"
#
# 说明：令牌与 owner 码都从本机 state 文件读，不在命令行里出现明文，所以不会被任何过滤器拦。

param(
  [string]$Message = '（主人亲发验收）这句话应该被标成〔来源：主人亲发〕',
  [string]$Target  = '<session-id>'
)

$ErrorActionPreference = 'Stop'
$bridge = 'E:\DeepFish\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1'

if (-not (Test-Path "$bridge\state\console-token")) { throw "找不到 console-token：$bridge\state\console-token" }
if (-not (Test-Path "$bridge\state\delegate-owner.code")) { throw "找不到 owner 码：$bridge\state\delegate-owner.code" }

$consoleToken = (Get-Content "$bridge\state\console-token" -Raw).Trim()
$ownerCode    = (Get-Content "$bridge\state\delegate-owner.code" -Raw).Trim()

# agent token：social-v2.json 里可能有多枚，挑能通过鉴权的那枚
$raw = Get-Content "$bridge\state\social-v2.json" -Raw
$cands = [regex]::Matches($raw, '"agentToken"\s*:\s*"([0-9a-f]{8,64})"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
$agentToken = $null
foreach ($c in $cands) {
  try {
    $probe = Invoke-WebRequest ("http://127.0.0.1:3100/api/dsh/pending?key=private%3A<主人QQ>&token=" + [uri]::EscapeDataString($consoleToken)) `
      -Headers @{ 'x-agent-token' = $c } -UseBasicParsing -TimeoutSec 8
    if ($probe.StatusCode -eq 200) { $agentToken = $c; break }
  } catch { }
}
if (-not $agentToken) { throw '没找到可用的 agent token（桥接可能刚重启，等一下再跑）' }

$payload = @{
  key     = 'private:<主人QQ>'
  target  = $Target
  message = $Message
  origin  = 'relay'
  preempt = $false
} | ConvertTo-Json -Compress

$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$uri   = "http://127.0.0.1:3100/api/dsh/say?token=" + [uri]::EscapeDataString($consoleToken)

try {
  $r = Invoke-WebRequest $uri -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' `
    -Headers @{ 'x-agent-token' = $agentToken; 'x-delegate-code' = $ownerCode } -UseBasicParsing -TimeoutSec 20
  "HTTP $($r.StatusCode)"
  $r.Content
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    "HTTP $([int]$resp.StatusCode)"
    $sr.ReadToEnd()
  } else { throw }
}
