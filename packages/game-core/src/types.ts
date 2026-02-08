export type ScreenMode = "base" | "map" | "battle" | "editor";

export type MaterialId = "basic" | "reinforced" | "ceramic" | "reactive" | "combined";

export type ComponentId =
| "control"
| "engineS"
| "engineM"
| "jetEngine"
| "propeller"
| "cannonLoader"
| "missileLoader"
  | "rapidGun"
  | "heavyCannon"
  | "explosiveShell"
  | "trackingMissile"
  | "precisionBeam"
  | "empEmitter"
  | "fuel"
  | "ammo";

export type WeaponClass =
  | "rapid-fire"
  | "heavy-shot"
  | "explosive"
  | "tracking"
  | "beam-precision"
  | "control-utility";

export type ExplosiveDeliveryMode = "shell" | "bomb";

export type UnitType = "ground" | "air";
export type Side = "player" | "enemy";

export interface MaterialStats {
  readonly label: string;
  readonly mass: number;
  readonly armor: number;
  readonly hp: number;
  readonly recoverPerSecond: number;
  readonly color: string;
}

export interface ComponentStats {
  readonly type: "control" | "engine" | "weapon" | "loader" | "fuel" | "ammo";
  readonly mass: number;
  readonly hpMul: number;
  readonly directional?: boolean;
  readonly propulsion?: {
    readonly platform: "ground" | "air";
    readonly mode: "omni" | "directional";
    readonly thrustAngleDeg?: number;
    readonly preferVertical?: boolean;
  };
  readonly placement?: {
    readonly footprintOffsets?: ReadonlyArray<{ x: number; y: number }>;
    readonly requireStructureOnFootprint?: boolean;
    readonly requireEmptyOffsets?: ReadonlyArray<{ x: number; y: number }>;
    readonly requireStructureBelowAnchor?: boolean;
  };
  readonly power?: number;
  readonly maxSpeed?: number;
  readonly weaponClass?: WeaponClass;
  readonly recoil?: number;
  readonly hitImpulse?: number;
  readonly damage?: number;
  readonly range?: number;
  readonly cooldown?: number;
  readonly shootAngleDeg?: number;
  readonly projectileSpeed?: number;
  readonly projectileGravity?: number;
  readonly spreadDeg?: number;
  readonly explosive?: {
    readonly deliveryMode: ExplosiveDeliveryMode;
    readonly blastRadius: number;
    readonly blastDamage: number;
    readonly falloffPower: number;
    readonly fuse: "impact" | "timed";
    readonly fuseTime?: number;
  };
  readonly tracking?: {
    readonly turnRateDegPerSec: number;
  };
  readonly control?: {
    readonly impairFactor: number;
    readonly duration: number;
  };
  readonly loader?: {
    readonly supports: ReadonlyArray<WeaponClass>;
    readonly loadMultiplier: number;
    readonly fastOperation: boolean;
    readonly minLoadTime: number;
    readonly storeCapacity: number;
    readonly minBurstInterval: number;
  };
}

export interface StructureCellTemplate {
  material: MaterialId;
  x?: number;
  y?: number;
}

export interface AttachmentTemplate {
  component: ComponentId;
  cell: number;
  x?: number;
  y?: number;
  rotateQuarter?: number;
  rotate90?: boolean;
}

export interface DisplayAttachmentTemplate {
  kind: "panel" | "stripe" | "glass";
  cell: number;
  x?: number;
  y?: number;
}

export interface UnitTemplate {
  id: string;
  name: string;
  type: UnitType;
  gasCost: number;
  structure: StructureCellTemplate[];
  attachments: AttachmentTemplate[];
  display?: DisplayAttachmentTemplate[];
}

export interface StructureCell {
  id: number;
  material: MaterialId;
  x: number;
  y: number;
  strain: number;
  breakThreshold: number;
  recoverPerSecond: number;
  destroyed: boolean;
}

export interface Attachment {
  id: number;
  component: ComponentId;
  cell: number;
  x: number;
  y: number;
  rotateQuarter: number;
  alive: boolean;
}

export interface UnitInstance {
  id: string;
  templateId: string;
  side: Side;
  type: UnitType;
  name: string;
  facing: 1 | -1;
  x: number;
  y: number;
  vx: number;
  vy: number;
  accel: number;
  maxSpeed: number;
  turnDrag: number;
  radius: number;
  structure: StructureCell[];
  attachments: Attachment[];
  controlAttachmentId: number;
  weaponAttachmentIds: number[];
  selectedWeaponIndex: number;
  weaponAutoFire: boolean[];
  weaponFireTimers: number[];
  weaponReadyCharges: number[];
  weaponLoadTimers: number[];
  loaderStates: LoaderState[];
  deploymentGasCost: number;
  returnedToBase: boolean;
  aiTimer: number;
  aiAimCorrectionY: number;
  aiState: "engage" | "evade";
  aiStateTimer: number;
  aiDodgeCooldown: number;
  aiLastThreatDirX: number;
  aiLastThreatDirY: number;
  aiDebugTargetId: string | null;
  aiDebugShouldEvade: boolean;
  aiDebugLastAngleRad: number;
  aiDebugLastRange: number;
  aiDebugDecisionPath: string;
  aiDebugFireBlockReason: string | null;
  aiDebugPreferredWeaponSlot: number;
  aiDebugLeadTimeS: number;
  aiWeaponCycleIndex: number;
  controlImpairTimer: number;
  controlImpairFactor: number;
  airDropActive: boolean;
  airDropTargetY: number;
  alive: boolean;
  vibrate: number;
  mass: number;
}

export interface LoaderState {
  attachmentId: number;
  targetWeaponSlot: number | null;
  remaining: number;
}

export interface Projectile {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  traveledDistance: number;
  maxDistance: number;
  hitUnitIds: string[];
  shooterWasAI: boolean;
  intendedTargetId: string | null;
  intendedTargetX: number;
  intendedTargetY: number;
  hitIntendedTarget: boolean;
  axisY: number;
  allowAirPierce: boolean;
  gravity: number;
  weaponClass: WeaponClass;
  explosiveBlastRadius: number;
  explosiveBlastDamage: number;
  explosiveFalloffPower: number;
  explosiveFuse: "impact" | "timed";
  controlImpairFactor: number;
  controlImpairDuration: number;
  homingTargetId: string | null;
  homingAimX: number;
  homingAimY: number;
  homingTurnRateDegPerSec: number;
  ttl: number;
  sourceId: string;
  side: Side;
  sourceWeaponAttachmentId: number | null;
  damage: number;
  hitImpulse: number;
  r: number;
}

export interface Particle {
  x: number;
  y: number;
  life: number;
  size: number;
}

export interface Debris {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  kind: "structure" | "functional";
  life: number;
  grounded: boolean;
}

export interface BattleBase {
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BattleOutcome {
  victory: boolean;
  reason: string;
}

export interface BattleState {
  active: boolean;
  nodeId: string | null;
  units: UnitInstance[];
  projectiles: Projectile[];
  particles: Particle[];
  debris: Debris[];
  playerBase: BattleBase;
  enemyBase: BattleBase;
  enemyGas: number;
  enemyCap: number;
  enemyMinActive: number;
  enemyInfiniteGas: boolean;
  enemySpawnTimer: number;
  outcome: BattleOutcome | null;
}

export interface MapNode {
  id: string;
  name: string;
  owner: "neutral" | "player" | "enemy";
  garrison: boolean;
  reward: number;
  defense: number;
  testEnemyMinActive?: number;
  testEnemyInfiniteGas?: boolean;
  testBaseHpOverride?: number;
}

export interface GameBase {
  areaLevel: number;
  refineries: number;
  workshops: number;
  labs: number;
}

export interface TechState {
  reinforced: boolean;
  ceramic: boolean;
  combined: boolean;
  reactive: boolean;
  mediumWeapons: boolean;
}

export interface KeyState {
  a: boolean;
  d: boolean;
  w: boolean;
  s: boolean;
  space: boolean;
}
