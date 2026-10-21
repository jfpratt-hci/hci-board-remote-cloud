' Opens the Board Remote dashboard as its own window (Edge app mode), or in the default browser.
Set sh = CreateObject("WScript.Shell")
On Error Resume Next
sh.Run "msedge --app=http://localhost:7755/ --window-size=1600,940", 1, False
If Err.Number <> 0 Then
  Err.Clear
  sh.Run "http://localhost:7755/", 1, False
End If
