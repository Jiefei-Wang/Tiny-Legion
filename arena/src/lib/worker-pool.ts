import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

type WorkerRequest = { id: string; payload: unknown };
type WorkerResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export class WorkerPool {
  private readonly workers: Worker[];
  private readonly idle: Worker[];
  private readonly pending: Array<{ req: WorkerRequest; resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  private readonly inflight: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;

  constructor(workerFileUrl: string, size: number) {
    const resolvedSize = Math.max(1, Math.floor(size));
    this.workers = [];
    this.idle = [];
    this.pending = [];
    this.inflight = new Map();
    for (let i = 0; i < resolvedSize; i += 1) {
      const spec = workerFileUrl.startsWith("file:") ? new URL(workerFileUrl) : workerFileUrl;
      const worker = new Worker(spec as any, { stdout: false, stderr: false });
      worker.on("message", (msg: WorkerResponse) => this.onMessage(worker, msg));
      worker.on("error", (err: Error) => this.onError(worker, err));
      worker.on("exit", (code: number) => {
        if (code !== 0) {
          this.onError(worker, new Error(`worker exited with code ${code}`));
        }
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  public static matchWorkerUrl(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    const workerPath = resolve(here, "..", "worker", "match-worker.js");
    return pathToFileURL(workerPath).href;
  }

  public run(payload: unknown): Promise<unknown> {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const req: WorkerRequest = { id, payload };
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.push({ req, resolve: resolvePromise, reject: rejectPromise });
      this.pump();
    });
  }

  public async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }

  private pump(): void {
    while (this.idle.length > 0 && this.pending.length > 0) {
      const worker = this.idle.pop();
      const item = this.pending.shift();
      if (!worker || !item) {
        return;
      }
      this.inflight.set(item.req.id, { resolve: item.resolve, reject: item.reject });
      worker.postMessage(item.req);
    }
  }

  private onMessage(worker: Worker, msg: WorkerResponse): void {
    const handlers = this.inflight.get(msg.id);
    if (!handlers) {
      return;
    }
    this.inflight.delete(msg.id);
    this.idle.push(worker);
    this.pump();
    if (msg.ok) {
      handlers.resolve(msg.result);
    } else {
      handlers.reject(new Error(msg.error));
    }
  }

  private onError(worker: Worker, err: Error): void {
    // Fail all inflight requests (simple approach).
    for (const [id, handlers] of this.inflight.entries()) {
      this.inflight.delete(id);
      handlers.reject(err);
    }
    // Remove worker from pools.
    this.idle.splice(this.idle.indexOf(worker), 1);
  }
}
