/**
 * 处理模型目录、文本能力和默认模型选择。
 * 从目录记录判断文本能力、默认型号与推理档位，并生成配置问题；不自行探测供应商或假定未知型号具备能力。
 * EN: Handles model catalogs, text capability, and default selection. Derives text capability, default model, reasoning effort, and configuration issues from catalog records without probing providers or assuming capabilities for unknown models.
 */
import type { ProviderConfig } from '../../../packages/contracts/src/index';

/**
 * 供应商目录的能力提示；可选字段允许兼容旧目录，不代表连接或当前型号已通过实际调用。
 * EN: Optional catalog capability hints support legacy data; they do not establish a verified connection or real model call.
 */
export type CatalogModel = {
  id: string;
  name?: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  inputModalities?: string[];
  isDefault?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export {
  officialDeepSeek,
  deepSeekModelReplacement,
  retiredDeepSeekModelIssue,
} from '../../../packages/providers/src/deepseek';

/**
 * 目录未声明输入模态时兼容旧数据；明确声明时必须包含 text。
 * EN: Accept absent modality metadata for legacy catalogs; an explicit list must contain text.
 */
export function supportsText(model: CatalogModel): boolean {
  return !Array.isArray(model.inputModalities) || model.inputModalities.includes('text');
}

/**
 * 在支持文本的型号中依次选择用户偏好、目录默认项或第一项。
 * EN: Among text models prefer the user choice, then catalog default, then first entry.
 */
export function initialTextModel(models: CatalogModel[], preferred?: string): CatalogModel | undefined {
  const usable = models.filter(supportsText);
  return (
    usable.find((model) => model.id === preferred) || usable.find((model) => model.isDefault) || usable[0]
  );
}

/**
 * 默认推理强度必须出现在可选列表，否则回退到第一项。
 * EN: Use default effort only when allowed; otherwise choose the first effort.
 */
export function initialEffort(model: CatalogModel): ProviderConfig['reasoningEffort'] {
  return (
    model.efforts?.includes(model.defaultEffort || '') ? model.defaultEffort : model.efforts?.[0]
  ) as ProviderConfig['reasoningEffort'];
}

/**
 * 返回选择不可用的具体原因；空字符串表示当前型号可用于文本对话。
 * EN: Return a concrete invalid-choice reason, or empty text when the model supports this text conversation.
 */
export function catalogIssue(models: CatalogModel[], modelId?: string): string {
  if (!models.some(supportsText)) return '当前目录没有支持文字对话的型号，请刷新目录或切换连接。';
  if (!modelId) return '请选择支持文字对话的型号。';
  const model = models.find((item) => item.id === modelId);
  if (!model) return '所选型号已不在当前目录中，请重新选择支持文字对话的型号。';
  return supportsText(model) ? '' : '所选型号不支持文字对话，请重新选择支持文字对话的型号。';
}
