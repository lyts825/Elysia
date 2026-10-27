// 在 Windows 上启动 MCP 子进程并管理其运行环境。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../../contracts/src/index.js';

// Keep the supervisor itself alive until the server exits. Windows closes this non-inheritable
// Job Object on supervisor termination, including abrupt termination by taskkill or host shutdown.
// Program and argv arrive as structured environment data, never as PowerShell expressions.
const supervisor = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $launch = $env:ELYSIA_MCP_LAUNCH_DATA | ConvertFrom-Json
  Remove-Item Env:ELYSIA_MCP_LAUNCH_DATA
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ElysiaMcpJob {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Startup {
    public uint cb; public string reserved, desktop, title;
    public uint x, y, xs, ys, xc, yc, fill, flags;
    public short show, reservedSize; public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minimumWorkingSet, maximumWorkingSet; public uint activeProcesses;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string program, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
    ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value) {
    var output = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') output.Append('\\', slashes * 2 + 1).Append('"');
      else output.Append('\\', slashes).Append(c);
      slashes = 0;
    }
    return output.Append('\\', slashes * 2).Append('"').ToString();
  }
  public static int Run(string program, string[] args, string cwd, uint ownerId) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null); ProcessInfo process = new ProcessInfo();
    IntPtr owner = OpenProcess(0x00100000, false, ownerId);
    if (job == IntPtr.Zero) throw new InvalidOperationException();
    try {
      if (owner == IntPtr.Zero) throw new InvalidOperationException();
      var limits = new ExtendedLimits(); limits.basic.flags = 0x2000;
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        throw new InvalidOperationException();
      var startup = new Startup(); startup.cb = (uint)Marshal.SizeOf(typeof(Startup)); startup.flags = 0x100;
      startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
      SetHandleInformation(startup.input, 1, 1); SetHandleInformation(startup.output, 1, 1); SetHandleInformation(startup.error, 1, 1);
      var command = new StringBuilder(Quote(program));
      foreach (string arg in args) command.Append(' ').Append(Quote(arg));
      if (command.Length >= 32767 || !CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true,
          0x08000004, IntPtr.Zero, String.IsNullOrEmpty(cwd) ? null : cwd, ref startup, out process))
        throw new InvalidOperationException();
      if (!AssignProcessToJobObject(job, process.process)) {
        TerminateProcess(process.process, 125); throw new InvalidOperationException();
      }
      if (ResumeThread(process.thread) == UInt32.MaxValue) throw new InvalidOperationException();
      WaitForMultipleObjects(2, new IntPtr[] { process.process, owner }, false, UInt32.MaxValue);
      uint exit; return GetExitCodeProcess(process.process, out exit) ? unchecked((int)exit) : 125;
    } finally {
      CloseHandle(job);
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (owner != IntPtr.Zero) CloseHandle(owner);
    }
  }
}
'@
  $status = [ElysiaMcpJob]::Run([string]$launch.program, [string[]]$launch.args, [string]$launch.cwd, [uint32]$launch.ownerId)
  exit $status
} catch {
  [Console]::Error.WriteLine('MCP process supervisor failed')
  exit 125
}
`;

export function spawnMcpProcess(
  program: string,
  args: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32')
    return spawn(program, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const data = JSON.stringify({ program, args, cwd, ownerId: process.pid });
  if (data.length > 20000) throw new AppError('MCP_ARGUMENTS', 'Windows MCP 启动参数超过大小上限');
  return spawn(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(supervisor, 'utf16le').toString('base64'),
    ],
    {
      cwd,
      env: { ...env, ELYSIA_MCP_LAUNCH_DATA: data },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}
