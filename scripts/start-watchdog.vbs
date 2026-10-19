' KimiCode Pocket — 看门狗隐藏启动器
'
' 用法（推荐）：
'   1) Win+R → shell:startup
'   2) 右键拖动本文件到该目录 → 创建快捷方式（不要直接复制文件）
'   3) 下次登录即以隐藏窗口自动启动看门狗
'
' 为什么用快捷方式而不是复制：下面的路径是根据「本文件所在位置」自动推导的，
' 快捷方式不会改变它；把文件复制走就会找错目录。
'
' 手动停止：运行 scripts\stop.ps1

Option Explicit

Dim fso, shell, scriptDir, target, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
target = fso.BuildPath(scriptDir, "watchdog.ps1")

If Not fso.FileExists(target) Then
    MsgBox "找不到看门狗脚本：" & vbCrLf & target & vbCrLf & vbCrLf & _
           "请把本文件留在 kimicode-pocket\scripts\ 目录下（用快捷方式启动，不要复制）。", _
           vbCritical, "KimiCode Pocket"
    WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & target & """"
shell.Run cmd, 0, False
