# 编译 LilithAvatar（离线工具链，不需要装 .NET SDK）
#
# 用法：
#   .\build.ps1            # 只编译
#   .\build.ps1 -Deploy    # 编译 + 复制到游戏 Mods + 重启游戏
param(
    [switch]$Deploy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$game = 'E:\SteamLibrary\steamapps\common\The NOexistenceN of Lilith'
$csc = Join-Path $root 'toolchain\csc\tasks\netcore\bincore\csc.dll'
$refDir = Join-Path $root 'toolchain\ref\ref\net6.0'
$modDir = Join-Path $root 'mod'
$outDir = Join-Path $root 'bin'
$out = Join-Path $outDir 'LilithAvatar.dll'

if (-not (Test-Path $csc)) { throw "找不到编译器：$csc" }
if (-not (Test-Path $game)) { throw "找不到游戏目录：$game" }

$refs = @()
$refs += (Get-ChildItem (Join-Path $refDir '*.dll') | ForEach-Object { "-r:$($_.FullName)" })
$refs += @(
    "-r:$game\MelonLoader\net6\MelonLoader.dll",
    "-r:$game\MelonLoader\net6\Il2CppInterop.Runtime.dll",
    "-r:$game\MelonLoader\net6\Il2CppInterop.Common.dll",
    "-r:$game\MelonLoader\net6\Il2CppInterop.HarmonySupport.dll",
    "-r:$game\MelonLoader\net6\0Harmony.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\Il2Cppmscorlib.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\Il2CppSystem.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\Il2CppSystem.Core.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\UnityEngine.CoreModule.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\UnityEngine.IMGUIModule.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\UnityEngine.TextRenderingModule.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\UnityEngine.InputLegacyModule.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\UnityEngine.UI.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\UnityEngine.UIModule.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\Unity.TextMeshPro.dll",
    "-r:$game\MelonLoader\Il2CppAssemblies\UnityEngine.Physics2DModule.dll"
)

$src = Get-ChildItem (Join-Path $modDir '*.cs') | ForEach-Object { $_.FullName }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "编译 $($src.Count) 个源文件…"
& dotnet $csc -nologo -target:library -nostdlib+ -langversion:latest -out:$out @refs @src
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }
Write-Host "OK -> $out" -ForegroundColor Green

if ($Deploy) {
    $modFile = Join-Path $game 'Mods\LilithAvatar.dll'
    Get-Process Lilith -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    Copy-Item $out $modFile -Force
    Write-Host "已部署 -> $modFile" -ForegroundColor Green
    Start-Process -FilePath (Join-Path $game 'Lilith.exe') -WorkingDirectory $game
    Write-Host "游戏已启动"
}
