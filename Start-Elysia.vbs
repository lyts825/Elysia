Option Explicit
' 在项目根目录隐藏执行 Node 启动器，控制台输出保存到本地运行目录。
' 同步等待启动器结束，以退出码决定是否提示用户查看日志；应用生命周期由启动器负责。
' EN: Run the Node launcher hidden from the project root and capture console output locally.
' Wait for its exit code to decide whether to show the log location; the launcher owns app lifecycle.
Dim shell, fs, root, code
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
' 确保日志目录存在，路径来自当前 VBS 文件，支持从快捷方式或其他目录启动。
' EN: Ensure the log directory exists; derive paths from this VBS file to support shortcut and external-directory launches.
If Not fs.FolderExists(fs.BuildPath(root, ".elysia-runtime")) Then fs.CreateFolder(fs.BuildPath(root, ".elysia-runtime"))
' 隐藏 cmd 窗口并合并标准输出与错误；非零退出时保留日志，提示只提供位置不改写内容。
' EN: Hide cmd and merge stdout/stderr; preserve logs on failure and show their location without altering their contents.
code = shell.Run("cmd.exe /d /s /c ""node scripts\launch.mjs > .elysia-runtime\launcher.log 2>&1""", 0, True)
If code <> 0 Then MsgBox "Elysia could not start. See the error details in " & fs.BuildPath(root, ".elysia-runtime\launcher.log"), 16, "Elysia"
