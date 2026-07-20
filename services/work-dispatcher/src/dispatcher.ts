export interface WorkDispatcherConfig {
  dataServiceUrl: string;
  llmRunnerUrl: string;
  wecomWorkerUrl?: string;
  internalToken: string;
  workerId: string;
  pollIntervalMs: number;
  maxConcurrency: number;
  leaseSeconds: number;
  executionTimeoutMs: number;
  fetch: typeof fetch;
  onError?: (error: unknown) => void;
}

interface LeasedExecution {
  queue_item: { queue_id: string; stage_id: string; agent_id: string };
  execution: { execution_id: string };
  runtime_request: {
    bot_id: string;
    user_id: string;
    conversation_id: string;
    runtime: string;
    prompt: string;
  };
}

interface RuntimeResponse {
  run_id?: unknown;
  runner_session_id?: unknown;
  output?: unknown;
  code?: unknown;
  error?: unknown;
  details?: unknown;
}

export interface WorkDispatcher {
  start(): void;
  stop(): void;
  poll(): Promise<void>;
  waitForIdle(): Promise<void>;
  status(): { running: boolean; active: number; max_concurrency: number; worker_id: string };
}

export function createWorkDispatcher(config: WorkDispatcherConfig): WorkDispatcher {
  validateConfig(config);
  const active = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let polling = false;

  const schedule = () => {
    if (!running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll().catch(reportError).finally(schedule);
    }, config.pollIntervalMs);
    timer.unref?.();
  };

  const reportError = (error: unknown) => {
    config.onError?.(error);
  };

  const launch = (lease: LeasedExecution) => {
    const task = executeLease(config, lease)
      .catch(reportError)
      .finally(() => {
        active.delete(task);
        if (running) void poll().catch(reportError).finally(schedule);
      });
    active.add(task);
  };

  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      while (active.size < config.maxConcurrency) {
        const lease = await leaseNext(config);
        if (!lease) break;
        launch(lease);
      }
    } finally {
      polling = false;
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      void poll().catch(reportError).finally(schedule);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    poll,
    async waitForIdle() {
      while (active.size > 0 || polling) {
        if (active.size > 0) await Promise.allSettled([...active]);
        else await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    },
    status() {
      return {
        running,
        active: active.size,
        max_concurrency: config.maxConcurrency,
        worker_id: config.workerId,
      };
    },
  };
}

async function leaseNext(config: WorkDispatcherConfig): Promise<LeasedExecution | undefined> {
  const response = await config.fetch(new Request(`${config.dataServiceUrl}/internal/execution-queue/lease`, {
    method: "POST",
    headers: internalHeaders(config),
    body: JSON.stringify({ worker_id: config.workerId, lease_seconds: config.leaseSeconds }),
  }));
  if (response.status === 204) return undefined;
  if (!response.ok) throw new Error(`execution lease failed (${response.status})`);
  return response.json() as Promise<LeasedExecution>;
}

async function executeLease(config: WorkDispatcherConfig, lease: LeasedExecution): Promise<void> {
  let completion: Record<string, unknown>;
  try {
    const response = await config.fetch(new Request(`${config.llmRunnerUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trace-id": lease.execution.execution_id,
      },
      body: JSON.stringify({
        ...lease.runtime_request,
        trace_id: lease.execution.execution_id,
      }),
      signal: AbortSignal.timeout(config.executionTimeoutMs),
    }));
    const payload = await readRuntimePayload(response);
    if (!response.ok) {
      completion = {
        status: "failed",
        error_code: safeIdentifier(payload.code, "runtime_request_failed"),
        error_message: safeText(payload.error ?? payload.details, 4_000, `Runtime 请求失败 (${response.status})`),
      };
    } else {
      completion = {
        status: "succeeded",
        runner_session_id: safeIdentifier(payload.runner_session_id, undefined),
        output: safeText(payload.output, 100_000, "执行完成，但 Runtime 未返回正文"),
      };
    }
  } catch (error) {
    completion = {
      status: "failed",
      error_code: error instanceof DOMException && error.name === "TimeoutError"
        ? "dispatcher_timeout"
        : "runtime_unavailable",
      error_message: safeText(error instanceof Error ? error.message : error, 4_000, "Runtime 不可用"),
    };
  }

  const response = await config.fetch(new Request(
    `${config.dataServiceUrl}/internal/execution-runs/${encodeURIComponent(lease.execution.execution_id)}/complete`,
    {
      method: "POST",
      headers: internalHeaders(config),
      body: JSON.stringify(completion),
    },
  ));
  if (!response.ok) throw new Error(`execution completion failed (${response.status})`);
  if (config.wecomWorkerUrl) {
    const succeeded = completion.status === "succeeded";
    try {
      await config.fetch(new Request(`${config.wecomWorkerUrl}/internal/notifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bot_id: lease.runtime_request.bot_id,
          wecom_user_id: lease.runtime_request.user_id,
          text: succeeded
            ? `任务已完成：${lease.queue_item.stage_id}。请在 AgentLattice 工作台查看产物和执行结果。`
            : `任务执行未完成：${lease.queue_item.stage_id}。请在 AgentLattice 工作台查看原因并重试。`,
        }),
      }));
    } catch (error) {
      config.onError?.(new Error(`notification delivery failed: ${error instanceof Error ? error.message : "unknown"}`));
    }
  }
}

async function readRuntimePayload(response: Response): Promise<RuntimeResponse> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as RuntimeResponse;
  } catch {
    return { error: text };
  }
}

function internalHeaders(config: WorkDispatcherConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.internalToken}`,
  };
}

function safeIdentifier(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
  return fallback;
}

function safeText(value: unknown, maxLength: number, fallback: string): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 20)}\n[OUTPUT TRUNCATED]`;
}

function validateConfig(config: WorkDispatcherConfig): void {
  if (!config.internalToken.trim()) throw new Error("DATA_SERVICE_INTERNAL_TOKEN is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.workerId)) throw new Error("WORK_DISPATCHER_ID is invalid");
  if (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1 || config.maxConcurrency > 32) {
    throw new Error("WORK_DISPATCHER_MAX_CONCURRENCY must be between 1 and 32");
  }
  if (!Number.isInteger(config.leaseSeconds) || config.leaseSeconds < 30 || config.leaseSeconds > 3_600) {
    throw new Error("WORK_DISPATCHER_LEASE_SECONDS must be between 30 and 3600");
  }
}
