// Cancellation and cleanup protection share an atomic gate, so the parent never
// terminates a worker that has started object preflight or deletion.
export const OBJECT_CANCEL_FLAG = 0;
export const OBJECT_CLEANUP_GATE = 1;
export const OBJECT_READ_ONLY = 0;
export const OBJECT_PROTECTED = 1;
export const OBJECT_TERMINATING = 2;
export const OBJECT_CANCEL_GRACE_MS = 50;
