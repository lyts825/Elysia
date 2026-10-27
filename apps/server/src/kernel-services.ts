/** 组装服务端使用的内核实例。 */
import { Kernel } from '../../../packages/kernel/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';
import { freezeProjectCapabilities } from '../../../packages/context/src/project-intelligence.js';

/** 将项目能力冻结服务注入内核，使领域层通过回调而非直接依赖文件系统获取快照。 */
/** Composition boundary: the domain never imports filesystem-backed project knowledge. */
export function createKernel(store: Store) {
  return new Kernel(store, {
    captureProjectCapabilities: (projectId) => freezeProjectCapabilities(store, projectId),
  });
}
