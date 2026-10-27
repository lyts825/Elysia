// 识别评审模型与执行模型之间的身份冲突。
export interface ReviewModelAssignment {
  key: string;
  title: string;
  role: 'coordinator' | 'worker' | 'reviewer';
  model: string;
}

// Connection IDs, accounts, endpoints and reasoning effort do not identify a different model.
// 比较去除首尾空白并转为小写后的型号；返回首个冲突说明或 null。
export function reviewModelConflict(assignments: readonly ReviewModelAssignment[]) {
  const identity = (model: string) => model.trim().toLowerCase();
  for (const reviewer of assignments.filter((item) => item.role === 'reviewer')) {
    const worker = assignments.find(
      (item) => item.role !== 'reviewer' && identity(item.model) === identity(reviewer.model),
    );
    if (worker)
      return `审计任务“${reviewer.title}”与执行任务“${worker.title}”使用相同模型 ${reviewer.model}。请选择不同型号，或在任务约定中确认开启“允许审计与执行使用相同模型”。`;
  }
  return null;
}
