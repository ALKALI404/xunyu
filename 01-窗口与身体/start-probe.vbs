' Hidden launcher for the bridge(3100) side probe: avatar\probe-bridge.mjs
' Run by wscript with //B (no console window). Long-running is owned by the owner's scheduler;
' this file only makes sure the process starts detached and leaves a log behind.
'
' Same shape as E:\DSH-WeCom\bridge\start-watchdog.vbs:
'   CreateObject("WScript.Shell") + sh.Run(cmd, 0, False)  -- 0 = hidden, False = do not wait.
' Difference: node writes stdout/stderr, so redirect to avatar\state\probe-bridge*.log
' (append, never overwrite) -- otherwise a dead probe is invisible.
'
' NOTE: keep this file pure ASCII. WSH reads .vbs as ANSI; non-ASCII here would be mojibake.

Option Explicit

Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\DeepFish\avatar"

cmd = "cmd /c node ""E:\DeepFish\avatar\probe-bridge.mjs"" " & _
      ">> ""E:\DeepFish\avatar\state\probe-bridge.log"" " & _
      "2>> ""E:\DeepFish\avatar\state\probe-bridge.err.log"""

' 0 = hidden window; False = do not wait for exit
sh.Run cmd, 0, False

Set sh = Nothing
