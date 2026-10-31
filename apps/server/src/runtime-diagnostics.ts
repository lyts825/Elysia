/**
 * 为两个入口分别记录有界请求指标，错误关联使用服务端随机标识。
 * EN: Maintain bounded per-surface metrics and server-generated request correlation identifiers.
 * 只记录路由模板、状态和耗时，不收集 URL 参数、正文、错误原文或请求头。
 * EN: Record only route templates, status, and duration; omit parameters, bodies, error text, and headers.
 */
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, VERSION } from '../../../packages/contracts/src/index.js';
import type { RuntimeDiagnosticSnapshot } from '../../../packages/contracts/src/diagnostics.js';

const MAX_ROUTES = 64,
  MAX_SAMPLES = 128,
  MAX_ERRORS = 64;
const rounded = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value * 100) / 100) : 0);
type RequestState = { id: string; start: number; code?: string; finished?: boolean };
type Route = {
  method: string;
  route: string;
  count: number;
  failed: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
  cursor: number;
};

export function registerRuntimeDiagnostics(app: FastifyInstance, surface: 'native' | 'terminal') {
  const startedAt = new Date().toISOString(),
    started = performance.now();
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const states = new WeakMap<FastifyRequest, RequestState>(),
    routes = new Map<string, Route>();
  const errors: RuntimeDiagnosticSnapshot['errors'] = [];
  let total = 0,
    failed = 0,
    active = 0;
  const owns = (request: FastifyRequest) => request.url.startsWith('/terminal/') === (surface === 'terminal');
  const routeFor = (request: FastifyRequest) => request.routeOptions.url ?? '(unmatched)';
  const errorCode = (error: unknown) =>
    error instanceof AppError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'SERVER_ERROR';
  const append = (error: RuntimeDiagnosticSnapshot['errors'][number]) => {
    errors.push(error);
    if (errors.length > MAX_ERRORS) errors.shift();
  };
  app.addHook('onRequest', async (request, reply) => {
    if (!owns(request)) return;
    const state: RequestState = { id: randomUUID(), start: performance.now() };
    states.set(request, state);
    reply.header('x-elysia-request-id', state.id);
    total++;
    active++;
    // 客户端断开时也结束计数；完成响应与 close 回调共享一次结算。
    // EN: Finalize disconnected requests too; response and close callbacks share one settlement.
    const finish = (status: number) => {
      if (state.finished) return;
      state.finished = true;
      active--;
      const duration = performance.now() - state.start,
        isFailure = status >= 400;
      if (isFailure) failed++;
      let route = routeFor(request),
        key = request.method + ' ' + route;
      if (!routes.has(key) && routes.size >= MAX_ROUTES - 1) {
        route = '(other)';
        key = '(other)';
      }
      let record = routes.get(key);
      if (!record) {
        record = {
          method: route === '(other)' ? '*' : request.method,
          route,
          count: 0,
          failed: 0,
          totalMs: 0,
          maxMs: 0,
          samples: [],
          cursor: 0,
        };
        routes.set(key, record);
      }
      record.count++;
      if (isFailure) record.failed++;
      record.totalMs += duration;
      record.maxMs = Math.max(record.maxMs, duration);
      record.samples[record.cursor] = duration;
      record.cursor = (record.cursor + 1) % MAX_SAMPLES;
      if (isFailure)
        append({
          at: new Date().toISOString(),
          requestId: state.id,
          method: request.method,
          route,
          statusCode: status,
          code: state.code ?? (status === 499 ? 'CLIENT_DISCONNECTED' : 'HTTP_ERROR'),
        });
    };
    reply.raw.once('finish', () => finish(reply.statusCode));
    reply.raw.once('close', () => finish(reply.raw.writableFinished ? reply.statusCode : 499));
  });
  app.addHook('onClose', async () => histogram.disable());

  const snapshot = (): RuntimeDiagnosticSnapshot => {
    const memory = process.memoryUsage();
    return {
      version: VERSION,
      surface,
      startedAt,
      capturedAt: new Date().toISOString(),
      uptimeSeconds: rounded((performance.now() - started) / 1000),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
      eventLoop: {
        meanMs: rounded(histogram.mean / 1e6),
        p95Ms: rounded(histogram.percentile(95) / 1e6),
        maxMs: rounded(histogram.max / 1e6),
      },
      requests: { total, failed, active },
      routes: [...routes.values()].map((record) => {
        const samples = [...record.samples].sort((a, b) => a - b);
        return {
          method: record.method,
          route: record.route,
          count: record.count,
          failed: record.failed,
          meanMs: rounded(record.totalMs / record.count),
          p95Ms: rounded(samples[Math.ceil(samples.length * 0.95) - 1]),
          maxMs: rounded(record.maxMs),
          samples: samples.length,
        };
      }),
      errors: errors.map((error) => ({ ...error })),
    };
  };
  return {
    snapshot,
    recordError(request: FastifyRequest, code: string) {
      const state = states.get(request);
      if (state) state.code = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SERVER_ERROR';
      return state?.id;
    },
    backgroundError(error: unknown) {
      append({
        at: new Date().toISOString(),
        requestId: null,
        method: 'BACKGROUND',
        route: 'project-schedules',
        statusCode: 500,
        code: errorCode(error),
      });
    },
  };
}
