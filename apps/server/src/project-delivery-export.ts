/** 将项目交付清单导出为 Markdown。 */
import type { ProjectDeliveryManifest } from '../../../packages/contracts/src/project-delivery.js';

/** 用比正文内最长反引号串更长的围栏包裹用户文本，避免标题、HTML 或链接改变导出结构。 */
function literal(value: string) {
  let length = 3;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}text\n${value}\n${fence}`;
}
function paragraph(label: string, value: string) {
  return `**${label}**\n\n${literal(value || '（未填写）')}`;
}
function list(label: string, values: string[]) {
  return `**${label}**\n\n${values.length ? values.map((v, i) => `**第 ${i + 1} 项**\n\n${literal(v)}`).join('\n\n') : '（无）'}`;
}

/** 只从冻结快照生成可重复导出的 Markdown，不查询当前任务或打开产物正文。
 * 保留任务标准、人工确认、复核和来源意见处置的对应关系；结构核验与证据不替代质量判断。
 */
export function projectDeliveryMarkdown(manifest: ProjectDeliveryManifest) {
  const sections = [
    '# 项目冻结交付清单',
    paragraph('清单名称', manifest.title),
    paragraph('项目', manifest.projectName),
    `清单 ID：${manifest.id}  \n项目 ID：${manifest.projectId}  \n工作台版本：${manifest.boardRevision}  \n冻结时间：${manifest.createdAt}  \n完整性 SHA-256：${manifest.hash}`,
    '此清单记录冻结时人工选择、采纳与复验的元数据。执行完成不等于自动审定；文件正文不在清单内，不保证来源文件永久保留。后续修改或删除不会改变本清单。',
    '## 项目目标与范围',
    paragraph('目标', manifest.goal),
    list('范围', manifest.scope),
    list('非目标', manifest.nonGoals),
  ];
  for (const [index, entry] of manifest.items.entries()) {
    sections.push(
      `## 交付项 ${index + 1}`,
      paragraph('名称', entry.item.title),
      `交付项 ID：${entry.item.id}  \n语义版本：${entry.item.itemRevision}  \n必选：${entry.item.required ? '是' : '否'}`,
      paragraph('说明', entry.item.description),
      list('本交付项要求的产物', entry.item.deliverables),
      list('本交付项验收标准', entry.item.acceptanceCriteria),
      '### 选定任务与人工确认',
      paragraph('任务名称', entry.run.title),
      `任务 ID：${entry.run.id}  \n任务版本：${entry.run.revision}  \n根任务 ID：${entry.run.rootTaskId}  \n根任务版本：${entry.run.rootRevision}  \n交付指纹：${entry.run.fingerprint}`,
      paragraph('原任务目标', entry.run.objective),
      list('原任务交付物', entry.run.deliverables),
      list('原任务验收标准', entry.run.acceptanceCriteria),
      `确认时间：${entry.confirmation.confirmedAt}  \n确认绑定交付项版本：${entry.confirmation.itemRevision}  \n确认绑定复核 ID：${entry.confirmation.reviewId}`,
      paragraph('符合本项要求的人工确认说明', entry.confirmation.note),
      '### 当前采纳复核',
      `结论：已采纳  \n复核 ID：${entry.review.reviewId}  \n复核时间：${entry.review.reviewedAt}`,
      paragraph('总体意见', entry.review.note),
    );
    for (const note of entry.review.criteriaNotes)
      sections.push(
        `**原任务标准 ${note.index + 1} 的复核意见**`,
        paragraph('原标准', note.criterionText ?? '旧标准内容未记录'),
        paragraph('意见', note.note),
      );
    sections.push('### 选定产物元数据');
    if (!entry.artifacts.length) sections.push('本次未选择产物元数据。');
    for (const artifact of entry.artifacts)
      sections.push(
        paragraph('产物名称', artifact.name),
        `产物 ID：${artifact.id}  \n版本：${artifact.version}  \nSHA-256：${artifact.hash}  \n结构核验：${artifact.verified ? '已通过' : '未通过'}`,
        paragraph('媒体类型', artifact.mediaType),
      );
    sections.push('### 原任务结构化证据', '结构化证据和产物核验是可追溯记录，不替代人工对语义与质量的判断。');
    if (!entry.evidence.length) sections.push('没有结构化证据记录。');
    for (const [i, evidence] of entry.evidence.entries())
      sections.push(
        `**证据 ${i + 1} · 原任务标准 ${evidence.criterion + 1} · ${evidence.type}**`,
        paragraph('引用', evidence.ref),
        paragraph('摘要 / 说明', evidence.note),
        ...(evidence.hash ? [paragraph('SHA-256', evidence.hash)] : []),
      );
    sections.push(
      '### 来源意见复验',
      `共 ${entry.sourceNotes.total} 条，冻结时有效已解决 ${entry.sourceNotes.resolved} 条。`,
    );
    if (entry.source)
      sections.push(`原来源任务 ID：${entry.source.runId}  \n来源快照 SHA-256：${entry.source.hash}`);
    for (const row of entry.sourceFeedback) {
      const note = row.sourceNote,
        resolution = row.resolution;
      sections.push(
        `**来源意见 ${row.noteIndex + 1}**`,
        `来源：${note.origin === 'saved' ? '已保存复核' : '明确选择的本地草稿'}  \n原复核 ID：${note.reviewId ?? '无'}  \n原交付指纹：${note.fingerprint}`,
        paragraph('原标准', note.criterionText ?? '总体意见 / 原标准未记录'),
        paragraph('原意见', note.note),
      );
      if (resolution) {
        sections.push(
          `人工处置：${resolution.status === 'resolved' ? '已解决' : resolution.status === 'needs_changes' ? '仍需修改' : '待复验'}  \n处置版本：${resolution.revision}  \n复验时间：${resolution.updatedAt}  \n复验交付指纹：${resolution.fingerprint}`,
          paragraph('本次关联标准', resolution.criterionText ?? '总体交付'),
          paragraph('复验说明', resolution.note),
        );
        for (const evidence of resolution.evidence)
          sections.push(
            paragraph('复验证据引用', evidence.ref),
            paragraph('复验证据说明', evidence.note),
            ...(evidence.hash ? [paragraph('SHA-256', evidence.hash)] : []),
          );
      }
    }
  }
  return sections.join('\n\n') + '\n';
}
