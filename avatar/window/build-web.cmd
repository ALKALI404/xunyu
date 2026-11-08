@echo off
rem D51 (2026-10-28, workid 07 / window shell): build the WebView2 shell XunyuWebWindow.exe
rem   1) /win32icon: embeds the avatar icon into the exe (Explorer shows it)
rem   2) copies xunyu.ico next to the exe; runtime loads it by relative path, degrades if missing
rem Uses the .NET Framework 4.x csc that ships with Windows (no SDK, no NuGet, no network).
rem NOTE: this file is deliberately ASCII-only and avoids parentheses inside if-blocks -
rem       cmd.exe mis-parses both UTF-8 comments and parens in echoed text.
rem
rem Usage:  cd /d E:\DeepFish\avatar\window && build-web.cmd
rem Rollback: drop the /win32icon: arg and the form.Icon lines in WebShell.cs, rebuild.
setlocal
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" goto nocsc

rem Icon source: workspace assets first, else the local copy next to this script.
set ICO=%~dp0xunyu.ico
if exist "E:\DSH_workspace\assets\icon\xunyu.ico" set ICO=E:\DSH_workspace\assets\icon\xunyu.ico
set ICONARG=
if not exist "%ICO%" goto noicon
set ICONARG=/win32icon:"%ICO%"
echo [build] icon: %ICO%
goto compile

:noicon
echo [build] xunyu.ico not found - building WITHOUT /win32icon, exe gets no embedded icon.

:compile
echo [build] using %CSC%
"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /debug- ^
    %ICONARG% ^
    /out:XunyuWebWindow.exe ^
    /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
    /r:System.Web.Extensions.dll ^
    /r:vendor\Microsoft.Web.WebView2.Core.dll ^
    /r:vendor\Microsoft.Web.WebView2.WinForms.dll ^
    WebShell.cs
if errorlevel 1 goto failed

rem Ship the ico next to the exe - runtime reads this copy by relative path.
if exist "%ICO%" copy /y "%ICO%" "%~dp0xunyu.ico" >nul

echo [build] OK -^> %~dp0XunyuWebWindow.exe
dir /b XunyuWebWindow.exe xunyu.ico
exit /b 0

:failed
echo [build] FAILED - if the window is running, close it first: the exe file is locked.
exit /b 1

:nocsc
echo [build] csc.exe not found - .NET Framework 4.x is required.
exit /b 1
