/** 当前服务生命周期内的有界诊断；不含会话正文、参数、路径或凭据。
 * EN: Bounded diagnostics for the current service lifetime, excluding user content and credentials.
 */
export interface RuntimeDiagnosticSnapshot {
  version: string;
  surface: 'native' | 'terminal';
  startedAt: string;
  capturedAt: string;
  uptimeSeconds: number;
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  eventLoop: { meanMs: number; p95Ms: number; maxMs: number };
  requests: { total: number; failed: number; active: number };
  routes: {
    method: string;
    route: string;
    count: number;
    failed: number;
    meanMs: number;
    p95Ms: number;
    maxMs: number;
    samples: number;
  }[];
  errors: {
    at: string;
    requestId: string | null;
    method: string;
    route: string;
    statusCode: number;
    code: string;
  }[];
}
