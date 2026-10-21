' Starts the Board Remote keepalive with no window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
node = dir & "\tools\node\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.Run """" & node & """ """ & dir & "\server.js""", 0, False
