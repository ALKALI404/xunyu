' auto: hidden launch (no BOM, ASCII only)
' 2026-10-28 C1 fix: scheduled task starting powershell.exe directly flashes a console window.
' Launched via wscript with SW_HIDE instead. Task /TR:
'   wscript.exe //B //Nologo "E:\DeepFish\avatar\supervisor-hidden.vbs"
' Third arg True = wait for child (supervisor is long-running), so task instance lifetime is unchanged.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\DeepFish\avatar"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""E:\DeepFish\avatar\supervisor.ps1""", 0, True
