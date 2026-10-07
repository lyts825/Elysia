import type { ProviderConfig } from '../../../packages/contracts/src/index';

export type CatalogModel = {
  id: string;
  name?: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  inputModalities?: string[];
  isDefault?: boolean;
};

export function supportsText(model: CatalogModel): boolean {
  return !Array.isArray(model.inputModalities) || model.inputModalities.includes('text');
}

export function initialTextModel(models: CatalogModel[], preferred?: string): CatalogModel | undefined {
  const usable = models.filter(supportsText);
  return (
    usable.find((model) => model.id === preferred) || usable.find((model) => model.isDefault) || usable[0]
  );
}

export function initialEffort(model: CatalogModel): ProviderConfig['reasoningEffort'] {
  return (
    model.efforts?.includes(model.defaultEffort || '') ? model.defaultEffort : model.efforts?.[0]
  ) as ProviderConfig['reasoningEffort'];
}

export function catalogIssue(models: CatalogModel[], modelId?: string): string {
  if (!models.some(supportsText)) return '当前目录没有支持文字对话的型号，请刷新目录或切换连接。';
  if (!modelId) return '请选择支持文字对话的型号。';
  const model = models.find((item) => item.id === modelId);
  if (!model) return '所选型号已不在当前目录中，请重新选择支持文字对话的型号。';
  return supportsText(model) ? '' : '所选型号不支持文字对话，请重新选择支持文字对话的型号。';
}
