/**
 * 在桌面主进程监督一个后端：已就绪进程异常退出才有限重启，心跳异常只提示。
 * EN: Supervise one backend from the desktop. Restart only ready processes that exit unexpectedly;
 * missed heartbeats request attention without terminating work or changing task state.
 */
const { performance } = require('node:perf_hooks');

function createBackendSupervisor(options) {
  const now = options.now || (() => performance.now());
  const later = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const windowMs = options.windowMs ?? 5 * 60 * 1000;
  const delays = options.delays ?? [1000, 3000, 10000];
  const heartbeatEveryMs = options.heartbeatEveryMs ?? 5000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 20000;
  let current,
    restartTimer,
    heartbeatTimer,
    stopped = false,
    wasReady = false,
    generation = 0,
    restarts = [],
    state = { status: 'starting', reason: 'initial-start' };

  function publish(status, reason, extra = {}) {
    const next = { status, reason, ...extra };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    options.onState?.({ ...state });
  }

  function clearHeartbeat() {
    if (heartbeatTimer !== undefined) cancel(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function isCurrent(child) {
    return !stopped && !!current && current.child === child && !current.exited;
  }

  function scheduleHeartbeat(record) {
    clearHeartbeat();
    heartbeatTimer = later(() => {
      heartbeatTimer = undefined;
      if (!isCurrent(record.child) || record.stopping || record.failed) return;
      if (record.pending) {
        if (now() - record.pending.at >= heartbeatTimeoutMs) publish('attention', 'heartbeat-timeout');
      } else {
        record.pending = { id: `${record.generation}:${++record.sequence}`, at: now() };
        try {
          if (!record.child.connected) publish('attention', 'ipc-unavailable');
          else
            record.child.send({ type: 'health-ping', id: record.pending.id }, (error) => {
              if (error && isCurrent(record.child) && !record.stopping && !record.failed)
                publish('attention', 'ipc-unavailable');
            });
        } catch {
          if (isCurrent(record.child)) publish('attention', 'ipc-unavailable');
        }
      }
      // 一个未答复的探测足够，不向繁忙的进程累积 IPC 消息，也不据此杀进程。
      // EN: Keep at most one unanswered probe; never flood or kill a busy process.
      if (isCurrent(record.child) && !record.stopping && !record.failed) scheduleHeartbeat(record);
    }, heartbeatEveryMs);
    heartbeatTimer.unref?.();
  }

  return {
    isCurrent,
    snapshot: () => ({ ...state }),
    attach(child) {
      if (stopped || (current && !current.exited)) return false;
      current = { child, generation: ++generation, sequence: 0, ready: false, exited: false };
      publish(wasReady ? 'recovering' : 'starting', 'awaiting-ready');
      return true;
    },
    ready(child) {
      if (!isCurrent(child) || current.ready || current.stopping || current.failed) return false;
      current.ready = true;
      wasReady = true;
      publish('healthy', 'ready');
      scheduleHeartbeat(current);
      return true;
    },
    heartbeat(child, id) {
      if (
        !isCurrent(child) ||
        !current.ready ||
        current.stopping ||
        current.failed ||
        !current.pending ||
        id !== current.pending.id
      )
        return false;
      current.pending = undefined;
      publish('healthy', 'ready');
      return true;
    },
    stopping(child) {
      if (!isCurrent(child) || current.failed) return false;
      current.stopping = true;
      clearHeartbeat();
      publish('stopping', 'backend-stop');
      return true;
    },
    failed(child) {
      if (!isCurrent(child) || current.stopping || current.failed) return false;
      current.failed = true;
      clearHeartbeat();
      publish('attention', wasReady ? 'recovery-failed' : 'initial-start-failed');
      return true;
    },
    unavailable(child) {
      if (!isCurrent(child) || current.stopping || current.failed) return false;
      publish('attention', 'ipc-unavailable');
      return true;
    },
    exited(child, code, signal) {
      if (!isCurrent(child)) return false;
      const record = current;
      record.exited = true;
      clearHeartbeat();
      if (record.failed) return true;
      if (record.stopping || (code === 0 && !signal)) {
        publish('stopped', 'normal-exit');
        options.onStopped?.();
        return true;
      }
      if (!record.ready) {
        publish('attention', wasReady ? 'recovery-failed' : 'initial-start-failed');
        return true;
      }
      const stamp = now();
      restarts = restarts.filter((at) => stamp - at < windowMs);
      if (restarts.length >= delays.length) {
        publish('attention', 'restart-limit');
        return true;
      }
      const delayMs = delays[restarts.length];
      restarts.push(stamp);
      publish('recovering', 'abnormal-exit', { attempt: restarts.length, delayMs });
      restartTimer = later(() => {
        restartTimer = undefined;
        if (stopped || current !== record || !record.exited) return;
        try {
          options.restart();
        } catch {
          publish('attention', 'recovery-failed');
        }
      }, delayMs);
      restartTimer.unref?.();
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearHeartbeat();
      if (restartTimer !== undefined) cancel(restartTimer);
      restartTimer = undefined;
      publish('stopping', 'desktop-stop');
    },
  };
}

/**
 * 就绪握手仅接受本机根页面及一次性引导令牌；错误不附带含令牌的输入。
 * EN: Accept only a loopback root and one-time bootstrap token. Errors never echo secret inputs.
 */
function backendReadyLocation(message, expectedVersion) {
  try {
    if (
      !message ||
      typeof message.origin !== 'string' ||
      typeof message.bootstrapUrl !== 'string' ||
      typeof message.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(message.version) ||
      (expectedVersion && message.version !== expectedVersion) ||
      !Number.isInteger(message.port) ||
      message.port < 1 ||
      message.port > 65535 ||
      !Number.isInteger(message.preferredPort) ||
      message.preferredPort < 0 ||
      message.preferredPort > 65535
    )
      throw new Error();
    const origin = new URL(message.origin);
    const bootstrap = new URL(message.bootstrapUrl);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      origin.origin !== message.origin ||
      bootstrap.origin !== origin.origin ||
      bootstrap.username ||
      bootstrap.password ||
      bootstrap.pathname !== '/' ||
      bootstrap.search ||
      !/^#bootstrap=[a-f0-9]{64}$/.test(bootstrap.hash)
    )
      throw new Error();
    return {
      origin: origin.origin,
      bootstrapUrl: bootstrap.href,
      version: message.version,
      port: message.port,
      preferredPort: message.preferredPort,
    };
  } catch {
    throw new Error('本机服务握手无效，或与分发包版本不一致');
  }
}

module.exports = { createBackendSupervisor, backendReadyLocation };
