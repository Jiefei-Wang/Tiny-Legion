import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ArenaSessionManager } from "./session-manager.ts";

type GrpcCall = {
  request: Record<string, unknown>;
};

type GrpcCallback<T> = (err: grpc.ServiceError | null, response?: T) => void;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function createService(manager: ArenaSessionManager): Record<string, grpc.UntypedHandleCall> {
  return {
    CreateBattle: (call: GrpcCall, callback: GrpcCallback<any>): void => {
      const config = parseJson(asString(call.request.config_json, "{}"), {});
      void manager.createBattle(config).then(
        (response) => callback(null, response),
        (err) => callback({
          name: "CreateBattleError",
          message: err instanceof Error ? err.message : String(err),
          code: grpc.status.INTERNAL,
        } as grpc.ServiceError),
      );
    },
    StepBattle: (call: GrpcCall, callback: GrpcCallback<any>): void => {
      const battleId = asString(call.request.battle_id, "");
      const nSteps = asNumber(call.request.n_steps, 1);
      const commands = Array.isArray(call.request.commands) ? call.request.commands : [];
      try {
        const response = manager.stepBattle(battleId, commands as any, nSteps);
        callback(null, response);
      } catch (err) {
        callback({
          name: "StepBattleError",
          message: err instanceof Error ? err.message : String(err),
          code: grpc.status.NOT_FOUND,
        } as grpc.ServiceError);
      }
    },
    GetBattle: (call: GrpcCall, callback: GrpcCallback<any>): void => {
      const battleId = asString(call.request.battle_id, "");
      try {
        const response = manager.getBattle(battleId);
        callback(null, response);
      } catch (err) {
        callback({
          name: "GetBattleError",
          message: err instanceof Error ? err.message : String(err),
          code: grpc.status.NOT_FOUND,
        } as grpc.ServiceError);
      }
    },
    CloseBattle: (call: GrpcCall, callback: GrpcCallback<any>): void => {
      const battleId = asString(call.request.battle_id, "");
      const ok = manager.closeBattle(battleId);
      callback(null, ok ? { ok: true, error: "" } : { ok: false, error: `battle not found: ${battleId}` });
    },
  };
}

export async function startGrpcServer(port: number): Promise<grpc.Server> {
  const here = dirname(fileURLToPath(import.meta.url));
  const protoFromRepoSource = resolve(here, "..", "..", "..", "..", "proto", "arena_service.proto");
  const protoFromCwd = resolve(process.cwd(), "proto", "arena_service.proto");
  const protoFromDistNeighbor = resolve(here, "..", "..", "proto", "arena_service.proto");
  const protoPath = existsSync(protoFromCwd)
    ? protoFromCwd
    : existsSync(protoFromRepoSource)
      ? protoFromRepoSource
      : protoFromDistNeighbor;
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDef) as any;
  const serviceDef = loaded.arena.v1.ArenaService.service;

  const manager = new ArenaSessionManager();
  const server = new grpc.Server();
  server.addService(serviceDef, createService(manager));

  await new Promise<void>((resolveBind, rejectBind) => {
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
      if (err) {
        rejectBind(err);
        return;
      }
      resolveBind();
    });
  });
  server.start();
  // eslint-disable-next-line no-console
  console.log(`[arena grpc] listening on 0.0.0.0:${port}`);
  return server;
}
