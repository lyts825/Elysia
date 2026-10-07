Option Explicit
Dim shell, fs, root, code
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
If Not fs.FolderExists(fs.BuildPath(root, ".elysia-runtime")) Then fs.CreateFolder(fs.BuildPath(root, ".elysia-runtime"))
code = shell.Run("cmd.exe /d /s /c ""node scripts\launch.mjs > .elysia-runtime\launcher.log 2>&1""", 0, True)
If code <> 0 Then MsgBox "Elysia could not start. See the error details in " & fs.BuildPath(root, ".elysia-runtime\launcher.log"), 16, "Elysia"
