/** 组装服务端使用的内核实例。 */
import { Kernel } from '../../../packages/kernel/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';
import { freezeProjectCapabilities } from '../../../packages/context/src/project-intelligence.js';

/**
 * 将项目能力采集作为服务回调注入内核。创建运行时由内核决定捕获时机和存储，
 * 文件系统知识只留在装配边界，领域层不直接读取当前可变资源。
 */
/** Composition boundary: the domain never imports filesystem-backed project knowledge. */
export function createKernel(store: Store) {
  return new Kernel(store, {
    captureProjectCapabilities: (projectId) => freezeProjectCapabilities(store, projectId),
  });
}
