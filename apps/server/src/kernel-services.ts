import { Kernel } from '../../../packages/kernel/src/index.js';
import type { Store } from '../../../packages/storage/src/index.js';
import { freezeProjectCapabilities } from '../../../packages/context/src/project-intelligence.js';

/** Composition boundary: the domain never imports filesystem-backed project knowledge. */
export function createKernel(store: Store) {
  return new Kernel(store, {
    captureProjectCapabilities: (projectId) => freezeProjectCapabilities(store, projectId),
  });
}
