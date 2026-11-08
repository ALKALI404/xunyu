' auto: hidden launch (no BOM!)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\DeepFish\avatar\memory-pipeline"
sh.Run "cmd /c """ & sh.CurrentDirectory & "\run-daily.cmd""", 0, False
