export interface ToolRecovery {
  kind:
    | 'arguments'
    | 'conflict'
    | 'scope'
    | 'permission'
    | 'evidence'
    | 'dependency'
    | 'verification'
    | 'state'
    | 'inspect';
  nextAction: string;
  availableTools: string[];
}

/** Advice for the next model step, never permission changes or automatic retries. */
export function toolRecovery(code: string, tool: string, toolNames: string[]): ToolRecovery {
  const availableTools = [...new Set(toolNames)].sort();
  const advice = (kind: ToolRecovery['kind'], nextAction: string): ToolRecovery => ({
    kind,
    nextAction,
    availableTools,
  });
  if (code === 'TOOL_ARGUMENTS')
    return advice(
      'arguments',
      `对照 ${tool} 的当前参数 schema 和错误信息修正参数，在下一步用完整 JSON 重新调用；不要改写同一条已记录调用的参数，也不要为可自行修正的参数向用户索要确认。`,
    );
  if (code === 'TOOL_CALL_CONFLICT')
    return advice(
      'arguments',
      '同一条已记录的工具调用不能改名或改参数。先核对其真实结果，需要修正时在下一次模型响应中发起完整调用；不能把旧结果当作新动作的完成证据。',
    );
  if (['FILE_CONFLICT', 'PATCH_AMBIGUOUS'].includes(code))
    return advice(
      'conflict',
      '用可用的 read 重新读取目标文件及真实哈希，核对现有修改后重新构造写入或唯一原文补丁；不要沿用过期哈希或覆盖其他修改。',
    );
  if (['PATH_ESCAPE', 'WRITE_SCOPE', 'EXEC_SCOPE', 'PATH_DENIED', 'ARTIFACT_SCOPE'].includes(code))
    return advice(
      'scope',
      '核对当前任务目录、合同允许路径和产物归属，改用授权范围内的目标。范围外的结果确属必要时说明具体路径缺口；继续完成范围内的工作，不重复同一越界调用。',
    );
  if (code === 'URL_PRIVATE')
    return advice(
      'scope',
      'fetch_url 不支持私网或保留地址，该限制不能靠补充同意或新任务的 URL 列表解除。改用已提供的本地资料或公开来源，必要时说明所需资料；继续其他已授权工作，不重复同一抓取。',
    );
  if (
    [
      'TOOL_DENIED',
      'TOOL_UNKNOWN',
      'PERMISSION_DENIED',
      'EXEC_DENIED',
      'NOT_AUTHORIZED',
      'URL_DENIED',
      'REDIRECT_DENIED',
    ].includes(code)
  )
    return advice(
      'permission',
      '按当前阶段、角色和 availableTools 改用可用能力继续。若缺少的读写、命令或精确 URL 授权确属必需，报告具体缺口；原任务的权限不能靠回复“同意”扩大，可在新任务配置所需最小权限。规划阶段则按现有计划接受流程处理，不把一次拒绝扩大为整项任务无法执行。',
    );
  if (
    [
      'ACCEPTANCE_INCOMPLETE',
      'ACCEPTANCE_MISSING',
      'CRITERION_SCOPE',
      'EVIDENCE_MISMATCH',
      'EVIDENCE_SCOPE',
      'COMMAND_EVIDENCE',
    ].includes(code)
  )
    return advice(
      'evidence',
      '按当前任务 acceptanceCriteria 核对缺失项，继续完成并登记真实文件、产物或成功命令证据后重新提交。只调整错误的证据引用，不能放宽验收项或声称失败已通过。',
    );
  if (
    [
      'TASK_KEY_EXISTS',
      'TASK_SCOPE',
      'WAIT_SCOPE',
      'DEPENDENCY_MISSING',
      'CHILDREN_INCOMPLETE',
      'SPAWN_DENIED',
      'AGENT_LIMIT',
      'DEPTH_LIMIT',
      'CYCLE',
    ].includes(code)
  )
    return advice(
      'dependency',
      '核对当前身份和 children，等待只使用实际直属子任务 ID。不要重复委派已有任务；不能继续拆分时自行完成本任务范围内可做的工作，必需子任务尚未完成则按实际状态等待或报告阻塞。',
    );
  if (['OPERATION_UNCERTAIN', 'MCP_CALL_UNCERTAIN', 'INTEGRATION_CONFLICT'].includes(code))
    return advice(
      'verification',
      '原操作可能已产生副作用，保留现有产物并按核验流程检查结果；不要自动重放该操作或用新调用绕过待核验状态。',
    );
  if (['TASK_STOPPED', 'STOPPED', 'RUN_ARCHIVED'].includes(code))
    return advice(
      'state',
      '当前任务已停止或归档，保留已有产物与错误记录，等待用户通过对应入口显式恢复；不要把执行指导或补充消息当作恢复授权。',
    );
  return advice(
    'inspect',
    '依据原错误检查具体原因及当前状态，能确定结果的可逆问题自行修复；结果未知的副作用先核验。继续其他不依赖该失败的已授权工作，不盲目重复相同调用。',
  );
}
