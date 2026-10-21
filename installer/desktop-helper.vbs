' Starts the Board Remote desktop helper for the person signing in, with no window.
' It opens Mirror and Shell windows on their screen when Board Remote (a Windows service) asks.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = fso.BuildPath(fso.GetParentFolderName(dir), "node\node.exe")
sh.Run """" & node & """ """ & fso.BuildPath(dir, "desktop-helper.js") & """", 0, False
