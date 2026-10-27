/** 按工具错误代码提供恢复信息。 */
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
/** 根据工具错误码生成恢复建议，并附上去重排序后的可用工具列表。 */
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
      `Correct the arguments using the current ${tool} parameter schema and error details, then issue a complete JSON call in the next step. Do not alter arguments of the same recorded call or request user confirmation for arguments you can fix yourself.`,
    );
  if (code === 'TOOL_CALL_CONFLICT')
    return advice(
      'arguments',
      'A recorded tool call cannot change its name or arguments. Inspect its actual result first, then issue a complete call in the next model response if a correction is needed. An old result does not prove completion of a new action.',
    );
  if (['FILE_CONFLICT', 'PATCH_AMBIGUOUS'].includes(code))
    return advice(
      'conflict',
      'Use read when available to reread the target file and actual hash. Inspect existing changes before rebuilding the write or unique-text patch. Do not reuse stale hashes or overwrite other changes.',
    );
  if (code === 'REVIEW_MODEL_CONFLICT')
    return advice(
      'dependency',
      'The review model conflicts with an execution model. Select a different model under the current role configuration. A different connection, account, or reasoning effort does not resolve this conflict; previously used models also count. Preserve allowSameModelReview in the contract. Only explicit user confirmation in the contract interface can enable same-model review. If no other model is available, explain the configuration needed without enabling an exception yourself or repeatedly retrying.',
    );
  if (code.startsWith('PEER_REVIEW_'))
    return advice(
      'evidence',
      'Check the current peerReview state, candidate ID, and original error. Scores must cover every criterion and cite actual evidence for that item. Execution models must revise based on failure feedback before resubmitting, not repeatedly request scores. Frozen models, rounds, and thresholds cannot change. Wait for a new candidate if the previous one is invalid; if rounds are exhausted, preserve feedback and explain that continuing requires a new task.',
    );
  if (['PATH_ESCAPE', 'WRITE_SCOPE', 'EXEC_SCOPE', 'PATH_DENIED', 'ARTIFACT_SCOPE'].includes(code))
    return advice(
      'scope',
      'Check the current task directory, contract-authorized paths, and artifact ownership, then use a target within scope. If an out-of-scope result is essential, identify the specific path authorization gap. Continue in-scope work without repeating the same out-of-scope call.',
    );
  if (code === 'URL_PRIVATE')
    return advice(
      'scope',
      'fetch_url does not support private or reserved addresses. Follow-up consent or a URL list in a new task cannot remove this restriction. Use supplied local material or a public source, and explain what information is needed when necessary. Continue other authorized work without repeating the same fetch.',
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
      'Continue with capabilities available for the current phase, role, and availableTools. If missing read, write, command, or exact-URL authorization is essential, report the specific gap. A reply of agreement cannot expand the original task permissions; a new task can configure the minimum required permissions. During planning, follow the existing plan-acceptance workflow. One denied call does not make the entire task impossible.',
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
      "Check missing items against the acceptanceCriteria for this task and zero-based criterion indexes. file evidence requires a readable path and actual hash. artifact evidence must belong to this task or a completed direct child. command evidence must use the operationId of a successful exec call in this task. Obtain real evidence within your current role; do not erase genuine unfinished work, relax acceptance criteria, or present someone else's results as your own operations.",
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
      'Check your current identity and children. Wait only on actual direct-child task IDs. Do not delegate existing work again. If further decomposition is unavailable, do what you can within this task scope. For unfinished required children, wait or report a blocker according to their actual state.',
    );
  if (['OPERATION_UNCERTAIN', 'MCP_CALL_UNCERTAIN', 'INTEGRATION_CONFLICT'].includes(code))
    return advice(
      'verification',
      'The original operation may already have caused side effects. Preserve existing artifacts and inspect the result through the verification workflow. Do not automatically replay the operation or issue a new call to bypass pending verification.',
    );
  if (['TASK_STOPPED', 'STOPPED', 'RUN_ARCHIVED'].includes(code))
    return advice(
      'state',
      'The task is stopped or archived. Preserve existing artifacts and error records, and wait for the user to explicitly resume it through the appropriate interface. Execution guidance and follow-up messages do not authorize resumption.',
    );
  return advice(
    'inspect',
    'Inspect the specific cause and current state using the original error. Fix reversible problems yourself when the outcome can be established; verify unknown side effects first. Continue other authorized work that does not depend on this failure, without blindly repeating the same call.',
  );
}
