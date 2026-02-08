import { startReplayServer } from "./replay-http-server.ts";

const port = Number(process.env.ARENA_REPLAY_PORT ?? 8790);
startReplayServer({ port });
// Keep process alive.
// eslint-disable-next-line no-console
console.log(`[arena-replay-server] listening on http://127.0.0.1:${port}`);
