import { parentPort } from "node:worker_threads";
import { runMatch } from "../match/run-match.ts";

type WorkerRequest = { id: string; payload: any };

if (!parentPort) {
  throw new Error("match-worker requires parentPort");
}

parentPort.on("message", async (msg: WorkerRequest) => {
  try {
    const result = await runMatch(msg.payload);
    parentPort?.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ id: msg.id, ok: false, error: message });
  }
});
