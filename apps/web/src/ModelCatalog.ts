/* 处理模型目录、文本能力和默认模型选择。 */
import type { ProviderConfig } from '../../../packages/contracts/src/index';

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

/** 目录未声明输入模态时兼容旧数据；明确声明时必须包含 text。 */
export function supportsText(model: CatalogModel): boolean {
  return !Array.isArray(model.inputModalities) || model.inputModalities.includes('text');
}

/** 在支持文本的型号中依次选择用户偏好、目录默认项或第一项。 */
export function initialTextModel(models: CatalogModel[], preferred?: string): CatalogModel | undefined {
  const usable = models.filter(supportsText);
  return (
    usable.find((model) => model.id === preferred) || usable.find((model) => model.isDefault) || usable[0]
  );
}

/** 默认推理强度必须出现在可选列表，否则回退到第一项。 */
export function initialEffort(model: CatalogModel): ProviderConfig['reasoningEffort'] {
  return (
    model.efforts?.includes(model.defaultEffort || '') ? model.defaultEffort : model.efforts?.[0]
  ) as ProviderConfig['reasoningEffort'];
}

/** 返回选择不可用的具体原因；空字符串表示当前型号可用于文本对话。 */
export function catalogIssue(models: CatalogModel[], modelId?: string): string {
  if (!models.some(supportsText)) return '当前目录没有支持文字对话的型号，请刷新目录或切换连接。';
  if (!modelId) return '请选择支持文字对话的型号。';
  const model = models.find((item) => item.id === modelId);
  if (!model) return '所选型号已不在当前目录中，请重新选择支持文字对话的型号。';
  return supportsText(model) ? '' : '所选型号不支持文字对话，请重新选择支持文字对话的型号。';
}
