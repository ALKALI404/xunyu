@echo off
rem Build XunyuChatWindow.exe with the .NET Framework 4.8 C# compiler that ships
rem with Windows (no SDK, no NuGet, no install). Output: single-file winexe
rem (no console window at all).
rem
rem Usage: double-click, or:  cd /d E:\DeepFish\avatar\window && build.cmd
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
    /r:System.Net.Http.dll /r:System.Web.Extensions.dll ^
    /out:XunyuChatWindow.exe ChatWindow.cs
if errorlevel 1 (
    echo [build] FAILED
    exit /b 1
)
echo [build] OK -^> %~dp0XunyuChatWindow.exe
dir /b XunyuChatWindow.exe
