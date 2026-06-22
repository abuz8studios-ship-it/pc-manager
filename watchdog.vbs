Option Explicit
Dim objShell, objHttp, alive
Set objShell = CreateObject("WScript.Shell")
Set objHttp  = CreateObject("MSXML2.XMLHTTP.6.0")
alive = False
On Error Resume Next
objHttp.Open "GET", "http://127.0.0.1:9100/api/summary", False
objHttp.Send
If Err.Number = 0 And objHttp.Status = 200 Then alive = True
On Error Goto 0
If Not alive Then
  objShell.CurrentDirectory = ".\pc-manager"
  objShell.Run "node.exe src\server.js", 0, False
End If
