/**
 * 共享 Claude 与 Antigravity 的非交互命令，保持目录、编辑器和运行时默认值一致。
 * EN: Shares noninteractive Claude and Antigravity commands across the catalog, editor and runtime.
 * 只返回新数组，不启动程序；容器权限和凭据仍由任务冻结配置约束。
 * EN: Returns fresh arrays without starting processes; frozen task settings still govern permissions and credentials.
 */
export function claudeTerminalCommand(): string[] {
  return ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions'];
}

/**
 * 用 JSONL 标准输入传入一个用户消息，关闭输入后等待该轮结果并退出。
 * EN: Receives one user message through JSONL stdin and exits after the turn completes and input closes.
 */
export function antigravityTerminalCommand(): string[] {
  return [
    'agy',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--disable-slash-commands',
    '--dangerously-skip-permissions',
  ];
}
