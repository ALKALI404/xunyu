' auto'
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\DeepFish\avatar\memory-pipeline"
sh.Run "cmd /c """ & sh.CurrentDirectory & "\probe.cmd""", 0, False
