' auto: hidden launch (no BOM!)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\DeepFish\avatar\memory-pipeline"
sh.Run "cmd /c """ & sh.CurrentDirectory & "\run-catchup.cmd""", 0, False
