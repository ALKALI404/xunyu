@echo off
rem 编译鲟鱼启动器（.NET Framework 自带 csc，无 SDK / 无 NuGet / 单文件 winexe）
setlocal
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo [build] csc.exe not found - .NET Framework 4.x is required.
    exit /b 1
)
echo [build] using %CSC%
"%CSC%" /nologo /target:winexe /optimize+ /debug- ^
    /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
    /r:System.Web.Extensions.dll ^
    /out:XunyuLauncher.exe XunyuLauncher.cs
if errorlevel 1 (
    echo [build] FAILED
    exit /b 1
)
echo [build] OK -^> %~dp0XunyuLauncher.exe
dir /b XunyuLauncher.exe
