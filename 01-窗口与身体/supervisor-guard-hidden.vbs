' auto: hidden launch (no BOM, ASCII only)
' 2026-10-28 C1 fix: scheduled task starting powershell.exe directly flashes a console window
' (Win11 hands console apps to Windows Terminal; -WindowStyle Hidden builds the window first).
' Launched via wscript with SW_HIDE instead. Task /TR:
'   wscript.exe //B //Nologo "E:\DeepFish\avatar\supervisor-guard-hidden.vbs"
' Third arg True = wait for child, so the task instance lifetime still equals the script lifetime
' (keeps MultipleInstances=IgnoreNew semantics unchanged).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\DeepFish\avatar"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""E:\DeepFish\avatar\supervisor-guard.ps1""", 0, True
