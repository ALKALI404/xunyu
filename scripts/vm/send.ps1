# scripts/vm/send.ps1 —— VM 内发送执行体（由宿主 vm-sender.mjs 通过计划任务调起）
# 输入：C:\Temp\wc-job.json {id, conv, texts:[...]}、C:\Temp\wc-cfg.json（坐标/类名/等待时间）
# 输出：C:\Temp\wc-result.json（ok/code/每条的前后截图 hash），退出码 0=全发出去了 1=没发/有失败
$ErrorActionPreference = 'Continue'
$t0 = Get-Date
$resultPath = 'C:\Temp\wc-result.json'
$jobPath = 'C:\Temp\wc-job.json'
$cfgPath = 'C:\Temp\wc-cfg.json'

function Write-Result($obj) {
  $obj | ConvertTo-Json -Depth 6 | Out-File $resultPath -Encoding UTF8
}

try {
  if (-not (Test-Path $jobPath)) { Write-Result ([ordered]@{ ok = $false; code = 'no-job' }); exit 1 }
  if (-not (Test-Path $cfgPath)) { Write-Result ([ordered]@{ ok = $false; code = 'no-config' }); exit 1 }
  $job = Get-Content $jobPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json

  . 'C:\Temp\vm\wecom-lib.ps1'

  $texts = @($job.texts)
  if ($texts.Count -eq 0) { $texts = @($job.text) }
  $res = [ordered]@{ id = $job.id; conv = $job.conv; at = (Get-Date).ToString('s'); steps = @(); sent = @() }

  $opened = Open-WeComChat -Conv $job.conv -Cfg $cfg
  $res.steps += ('open:' + $opened.code)
  if (-not $opened.ok) {
    $res.ok = $false
    $res.code = $opened.code
    $res.detail = '会话没打开/没验证成功，**未输入任何内容**（宁可不发，也不发错人）'
    $res.beforeHash = $opened.beforeHash
    $res.afterHash = $opened.afterHash
    $res.ms = [int]((Get-Date) - $t0).TotalMilliseconds
    Write-Result $res
    exit 1
  }
  $res.openCheck = @{ before = $opened.beforeHash; after = $opened.afterHash }

  $allOk = $true
  for ($i = 0; $i -lt $texts.Count; $i++) {
    $tag = "$($job.id)-$i"
    $one = Send-WeComText -Text ([string]$texts[$i]) -Cfg $cfg -Tag $tag
    $item = [ordered]@{
      i = $i
      code = $one.code
      ok = [bool]$one.ok
      beforeHash = $one.beforeHash
      afterHash = $one.afterHash
      textLen = ([string]$texts[$i]).Length
      beforePath = "C:\Temp\wc-$tag-before.png"
      afterPath = "C:\Temp\wc-$tag-after.png"
    }
    if (-not $one.ok) { $allOk = $false }
    $res.sent += $item
    $res.steps += ('send' + $i + ':' + $one.code)
  }

  $first = $res.sent[0]
  $last = $res.sent[$res.sent.Count - 1]
  $res.ok = $allOk
  $res.code = if ($allOk) { 'sent' } else { 'partial-failed' }
  # 判据要求：发送前后两张图的 sha256 必须不同（取第一条的 before 与最后一条的 after，最能说明"真的发出去了"）
  $res.beforeHash = $first.beforeHash
  $res.afterHash = $last.afterHash
  $res.ms = [int]((Get-Date) - $t0).TotalMilliseconds
  Write-Result $res
  if ($res.ok) { exit 0 } else { exit 1 }
} catch {
  Write-Result ([ordered]@{ ok = $false; code = 'exception'; detail = $_.Exception.Message; ms = [int]((Get-Date) - $t0).TotalMilliseconds })
  exit 1
}
