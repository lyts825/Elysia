/**
 * 组装服务端使用的内核实例。
 * 向内核提供服务端项目能力冻结接口；来源和账号校验留在服务边界，内核取得快照而非系统凭据能力。
 * EN: Composes the kernel used by server services. Provides server-side capability freezing to the kernel; sources/accounts remain server-validated and the kernel receives snapshots rather than vault capabilities.
 */
import { Kernel } from '../../../packages/kernel/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';
import { freezeProjectCapabilities } from '../../../packages/context/src/project-intelligence.js';

/**
 * 将项目能力采集作为服务回调注入内核。创建运行时由内核决定捕获时机和存储， 文件系统知识只留在装配边界，领域层不直接读取当前可变资源。 装配边界使领域层不导入依赖文件系统的项目知识。
 * EN: Injects project-capability capture as a kernel callback. The kernel owns capture timing and persistence at run creation; filesystem knowledge remains at this composition boundary rather than mutable-resource reads in the domain. Composition boundary: the domain never imports filesystem-backed project knowledge.
 */
export function createKernel(store: Store) {
  return new Kernel(store, {
    /**
     * 将内核的项目能力捕获委托给服务端冻结逻辑，返回创建时快照而非可变配置引用。
     * EN: Delegates kernel capability capture to server freezing logic, returning a creation-time snapshot instead of mutable configuration references.
     */
    captureProjectCapabilities: (projectId) => freezeProjectCapabilities(store, projectId),
  });
}
