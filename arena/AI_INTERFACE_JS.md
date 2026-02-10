# JS AI Interface

This document defines the JS-side interface for plugging trained models (for example ONNX) into game runtime AI control.

## Runtime function contract

Model adapter function:

```ts
type JsAiCallback = (
  snapshot: BattleSnapshot,
  pendingUnits: PendingUnit[],
  ctx: { step: number; dt: number; modelMeta?: Record<string, unknown> },
) => UnitStepCommand[];
```

Where `UnitStepCommand` is:

```ts
type UnitStepCommand = {
  unitId: string;
  move?: { dirX: number; dirY: number; allowDescend?: boolean };
  facing?: -1 | 0 | 1; // 0 => unchanged
  fireRequests?: Array<{
    slot: number;
    aimX: number;
    aimY: number;
    intendedTargetId?: string | null;
    intendedTargetY?: number | null;
  }>;
};
```

## Integration guidance

1. Build one stable feature extractor shared with Python training.
2. Keep exact feature order and normalization.
3. Store and check `feature_schema_version` in model metadata.
4. Convert model outputs into `UnitStepCommand`.
5. Keep server/runtime validation as final guardrails.

## ONNX adapter outline

```ts
export function onnxPolicyCallback(
  session: unknown, // ONNX runtime session
): JsAiCallback {
  return (snapshot, pendingUnits, ctx) => {
    const commands: UnitStepCommand[] = [];
    for (const unit of pendingUnits) {
      const features = extractFeatures(snapshot, unit, ctx);
      const out = infer(session, features);
      commands.push(decodeOutput(unit.unitId, out, snapshot));
    }
    return commands;
  };
}
```

## Compatibility note

Current game/arena command semantics are grounded in:

- `packages/game-core/src/types.ts` (`UnitCommand`, `FireRequest`)
- `packages/game-core/src/gameplay/battle/battle-session.ts` (command execution and validation)
