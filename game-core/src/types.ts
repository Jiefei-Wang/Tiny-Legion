export type ScreenMode = "base" | "map" | "battle" | "testArena" | "craftArena" | "leaderboard" | "templateEditor" | "partEditor";

export type MaterialId = "basic" | "reinforced" | "ceramic" | "reactive" | "combined";

export type ComponentId =
| "control"
| "engineS"
| "engineM"
| "jetEngine"
| "cannonLoader"
| "missileLoader"
  | "rapidGun"
  | "heavyCannon"
  | "explosiveShell"
| "trackingMissile"
  | "precisionBeam";

export type FireSoundPool =
  | "rapid-fire"
  | "heavy-shot"
  | "explosive"
  | "tracking"
  | "beam-precision";

export type ProjectileClass = "bullet" | "missile" | "laser";
export type BulletShape = "bullet-round" | "bullet-slug" | "bullet-tracer";
export type MissileShape = "missile-missile" | "missile-heavy-rocket" | "missile-energy-orb";
export type LaserShape = "laser-thin" | "laser-pulse" | "laser-wide";
export type ProjectileShape = BulletShape | MissileShape | LaserShape;

export interface ProjectileCapsuleAsset {
  readonly kind: "capsule";
  readonly centerX: number;
  readonly centerY: number;
  readonly halfLength: number;
  readonly radius: number;
}

export interface ProjectileBeamAsset {
  readonly kind: "beam-rect";
  readonly centerY: number;
  readonly halfHeight: number;
}

export interface ProjectileAssetDefinition {
  readonly projectileClass: ProjectileClass;
  readonly url: string;
  readonly aspect: number;
  readonly collider: ProjectileCapsuleAsset | ProjectileBeamAsset;
}

export type PartType = "structure" | "control" | "engine" | "weapon" | "loader";
export type PartCategory = "vehicle" | "jet" | "bullet" | "missile" | "beam";

export type UnitType = "ground" | "air" | "base";
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
  readonly type: "control" | "engine" | "weapon" | "loader";
  readonly mass: number;
  readonly hpMul: number;
  readonly gasCost?: number;
  readonly directional?: boolean;
  readonly propulsion?: {
    readonly platform: "ground" | "air";
    readonly mode: "omni";
  };
  readonly placement?: {
    readonly footprintOffsets?: ReadonlyArray<{ x: number; y: number }>;
    readonly requireStructureOnFootprint?: boolean;
    readonly requireEmptyOffsets?: ReadonlyArray<{ x: number; y: number }>;
  };
  readonly power?: number;
  readonly maxSpeed?: number;
  readonly projectileClass?: ProjectileClass;
  readonly projectileShape?: ProjectileShape;
  readonly projectileSizeRatio?: number;
  readonly maxLoadedAmmo?: number;
  readonly recoil?: number;
  readonly hitImpulse?: number;
  readonly damage?: number;
  readonly range?: number;
  readonly cooldown?: number;
  readonly hasAngleLimit?: boolean;
  readonly cwAngle?: number;
  readonly ccwAngle?: number;
  readonly projectileSpeed?: number;
  readonly projectileGravity?: number;
  readonly penetration?: number;
  readonly spreadDeg?: number;
  readonly explosive?: {
    readonly blastRadius: number;
    readonly blastDamage: number;
    readonly falloffPower: number;
  };
  readonly tracking?: {
    readonly turnRateDegPerSec: number;
  };
  readonly control?: {
    readonly impairFactor: number;
    readonly duration: number;
  };
  readonly loader?: {
    readonly supports: ReadonlyArray<ProjectileClass>;
    readonly loadMultiplier: number;
    readonly fastOperation: boolean;
    readonly minLoadTime: number;
    readonly minBurstInterval: number;
  };
}

export interface PartBoxTemplate {
  x: number;
  y: number;
  occupiesStructureSpace?: boolean;
  occupiesFunctionalSpace?: boolean;
  needsStructureBehind?: boolean;
  isAttachPoint?: boolean;
  isAnchorPoint?: boolean;
  isShootingPoint?: boolean;
  takesDamage?: boolean;
  // Legacy alias kept for backward compatibility with older part JSON.
  takesFunctionalDamage?: boolean;
}

export interface PartPlacementTemplate {
  requireStructureOffsets?: ReadonlyArray<{ x: number; y: number }>;
  requireStructureOnFunctionalOccupiedBoxes?: boolean;
  requireStructureOnStructureOccupiedBoxes?: boolean;
  requireEmptyStructureOffsets?: ReadonlyArray<{ x: number; y: number }>;
  requireEmptyFunctionalOffsets?: ReadonlyArray<{ x: number; y: number }>;
}

export interface PartStats {
  gasCost?: number;
  mass?: number;
  hpMul?: number;
  power?: number;
  maxSpeed?: number;
  recoil?: number;
  hitImpulse?: number;
  damage?: number;
  range?: number;
  cooldown?: number;
  projectileSpeed?: number;
  projectileGravity?: number;
  penetration?: number;
  spreadDeg?: number;
  explosiveBlastRadius?: number;
  explosiveBlastDamage?: number;
  explosiveFalloffPower?: number;
  trackingTurnRateDegPerSec?: number;
  controlImpairFactor?: number;
  controlDuration?: number;
  projectileClass?: ProjectileClass;
  projectileShape?: ProjectileShape;
  projectileSizeRatio?: number;
  loaderSupports?: ProjectileClass[];
  loaderLoadMultiplier?: number;
  loaderFastOperation?: boolean;
  loaderMinLoadTime?: number;
  loaderMinBurstInterval?: number;
}

export interface PartPropertySet {
  gasCost?: number;
  mass?: number;
  hp?: number;
  tag?: string;
  armor?: number;
  recover?: number;
  color?: string;
  alpha?: number;
  computing?: number;
  computingConsumption?: number;
  power?: number;
  maxSpeed?: number;
  powerGround?: boolean;
  powerAir?: boolean;
  hasAngleLimit?: boolean;
  cwAngle?: number;
  ccwAngle?: number;
  projectileClass?: ProjectileClass;
  projectileShape?: ProjectileShape;
  projectileSizeRatio?: number;
  damage?: number;
  range?: number;
  cooldown?: number;
  fireSoundVolume?: number;
  /** Recorded weapon-fire sample pool selected independently from combat behavior. */
  fireSoundPool?: FireSoundPool;
  recoil?: number;
  hitImpulse?: number;
  penetration?: number;
  spreadAngleDeg?: number;
  explodeOnHit?: boolean;
  explodeRadius?: number;
  projectileSpeed?: number;
  projectileGravity?: number;
  tracking?: boolean;
  trackingTurnRate?: number;
  needLoader?: boolean;
  /** Free-text ammunition identity used to match loader-managed weapons with loaders. */
  bulletName?: string;
  supportedWeaponTags?: string[];
  loadMultiplier?: number;
  minLoadTime?: number;
  minBurstInterval?: number;
  /** Maximum ready rounds stored directly by a weapon. */
  maxCapacity?: number;
  /** Minimum seconds between shots released from a multi-round weapon. */
  minFireInterval?: number;
  explosionDamage?: number;
  explosionRadius?: number;
}

export interface PartCellTemplate {
  x: number;
  y: number;
  structureOccupy?: boolean;
  functionalOccupy?: boolean;
  needStructureBehind?: boolean;
  takeDamage?: boolean;
  attachPoint?: boolean;
  anchorPoint?: boolean;
  firePoint?: boolean;
}

export interface PartDesignerProperties {
  category?: string;
  subcategory?: string;
  materialId?: MaterialId;
  materialArmor?: number;
  materialRecoverPerSecond?: number;
  materialColor?: string;
  materialAlpha?: number;
  hp?: number;
  isEngine?: boolean;
  isWeapon?: boolean;
  isLoader?: boolean;
  isArmor?: boolean;
  engineType?: "ground" | "air";
  projectileClass?: ProjectileClass;
  loaderServesTags?: string[];
  loaderCooldownMultiplier?: number;
  hasCoreTuning?: boolean;
}

export type PartDirection = "up" | "right" | "down" | "left";

export interface PartDefinition {
  id: number;
  name: string;
  layer: "functional" | "structure";
  partType?: PartType;
  partCategory?: PartCategory;
  baseComponent: ComponentId;
  directional?: boolean;
  direction?: PartDirection;
  anchor: { x: number; y: number };
  cells?: PartCellTemplate[];
  boxes: PartBoxTemplate[];
  placement?: PartPlacementTemplate;
  partProperties?: PartPropertySet;
  stats?: PartStats;
  properties?: PartDesignerProperties;
  tags?: string[];
}

export interface StructureCellTemplate {
  partId: number;
  x?: number;
  y?: number;
  /** Optional player-selected tint. The structure part color remains the default. */
  color?: string;
}

export interface AttachmentTemplate {
  component: ComponentId;
  partId?: number;
  cell: number;
  x?: number;
  y?: number;
  rotateQuarter?: number;
}

export interface DisplayAttachmentTemplate {
  kind: "panel" | "stripe" | "glass";
  cell: number;
  x?: number;
  y?: number;
}

export interface UnitTemplate {
  id: number;
  name: string;
  type: UnitType;
  gasCost: number;
  structure: StructureCellTemplate[];
  attachments: AttachmentTemplate[];
  display?: DisplayAttachmentTemplate[];
}

export interface StructureCell {
  id: number;
  partId: number;
  x: number;
  y: number;
  armor: number;
  mass: number;
  color: string;
  alpha: number;
  strain: number;
  breakThreshold: number;
  recoverPerSecond: number;
  destroyed: boolean;
}

export interface Attachment {
  id: number;
  component: ComponentId;
  partId?: number;
  cell: number;
  x: number;
  y: number;
  rotateQuarter: number;
  alive: boolean;
  /** Structure cells that support this functional part. Losing any one destroys the part. */
  attachedStructureCellIds: number[];
  occupiedOffsets?: Array<{
    x: number;
    y: number;
    occupiesStructureSpace: boolean;
    occupiesFunctionalSpace: boolean;
    needsStructureBehind: boolean;
    isAttachPoint: boolean;
    isShootingPoint: boolean;
    takesDamage: boolean;
    // Legacy alias kept to avoid broad runtime churn.
    takesFunctionalDamage: boolean;
  }>;
  shootingOffset?: { x: number; y: number };
  stats?: PartStats;
}

export interface UnitInstance {
  id: string;
  templateId: number;
  side: Side;
  type: UnitType;
  name: string;
  facing: 1 | -1;
  x: number;
  y: number;
  /** Immutable battlefield anchor used by stationary base templates. */
  fixedX: number | null;
  fixedY: number | null;
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
  weaponManualControl: boolean[];
  weaponAutoFire: boolean[];
  weaponFireTimers: number[];
  /** Visual-only world-space barrel angle per weapon slot. */
  weaponAimAngles: number[];
  weaponReadyCharges: number[];
  weaponLoadTimers: number[];
  loaderStates: LoaderState[];
  deploymentGasCost: number;
  returnedToBase: boolean;
  escapeActive: boolean;
  /** Seconds before an escaping craft turns to face its base. */
  escapeFacingDelayS: number;
  targetHistory: Array<{ x: number; y: number }>;
  targetHistorySampleTimerS: number;
  aiTimer: number;
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
  /** Remaining lifetime of a mission-killed ground wreck; null until wrecking begins. */
  groundWreckTimerS: number | null;
  /** Per-cell HP immediately after wreck-entry damage, indexed by structure-cell id. */
  groundWreckInitialCellHp: number[];
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
  hitPartKeys: string[];
  intendedTargetX: number;
  intendedTargetY: number;
  axisY: number;
  allowAirPierce: boolean;
  gravity: number;
  projectileClass: ProjectileClass;
  projectileShape: ProjectileShape;
  projectileSizeRatio: number;
  /** Nominal world-space height of the rendered SVG before class-specific collider fitting. */
  visualHeight: number;
  /** Resolved local capsule geometry, rotated to current velocity during collision/rendering. */
  capsuleCenterX: number;
  capsuleCenterY: number;
  capsuleHalfLength: number;
  capsuleRadius: number;
  explosiveBlastRadius: number;
  explosiveBlastDamage: number;
  explosiveFalloffPower: number;
  controlImpairFactor: number;
  controlImpairDuration: number;
  homingTargetId: string | null;
  homingAimX: number;
  homingAimY: number;
  homingTurnRateDegPerSec: number;
  ttl: number;
  sourceId: string;
  side: Side;
  sourceUnitType: UnitType;
  fireOriginY: number;
  initialVy: number;
  sourceWeaponAttachmentId: number | null;
  damage: number;
  /** Damage delivered by the next direct hit after penetration loss scaling. */
  currentDamage: number;
  hitImpulse: number;
  initialPenetration: number;
  remainingPenetration: number;
  r: number;
}

export interface Particle {
  x: number;
  y: number;
  life: number;
  size: number;
}

export interface BeamEffect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  side: Side;
  life: number;
  maxLife: number;
  shape: LaserShape;
  halfWidth: number;
}

export interface BlockExplosionEffect {
  x: number;
  y: number;
  age: number;
  life: number;
  size: number;
  variant: 0 | 1 | 2;
  seed: number;
  color: string;
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
  beamEffects: BeamEffect[];
  blockExplosions: BlockExplosionEffect[];
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
  kind?: "battlefield" | "oil" | "resource" | "outpost" | "remote-base" | "enemy-base";
  x?: number;
  y?: number;
  links?: string[];
  distanceFromHome?: number;
  gasDeposit?: boolean;
  resourceYieldPerMinute?: number;
  gasYieldPerMinute?: number;
  outpostTemplateIds?: number[];
  outpostRange?: number;
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
  /** Optional normalized controller left-stick movement axes. */
  moveX?: number;
  moveY?: number;
  /** Optional normalized controller right-stick aim direction. */
  aimX?: number;
  aimY?: number;
  /** Optional controller primary-fire state (normally right trigger/bumper). */
  manualFire?: boolean;
}

/** A fire request within a UnitCommand. */
export interface FireRequest {
  /** Weapon slot index to fire. */
  slot: number;
  /** Desired world firing angle in radians. The executor clamps to weapon limits. */
  angleRad: number;
  /** Optional target id used by homing weapons to prefer a specific target. */
  intendedTargetId: string | null;
  intendedTargetY: number | null;
  /** true = player manual click, false = AI / auto-fire. */
  manual: boolean;
}

/**
 * The universal command that all controllers (player input, combat AI,
 * retreat AI, air-drop AI) produce each tick. The executor applies it
 * with unified enforcement of movement physics, weapon constraints,
 * and boundary clamping.
 */
export interface UnitCommand {
  /** Movement intent: normalized direction inputs (roughly -1..1). */
  move: {
    dirX: number;
    dirY: number;
    /** Air units only — when true, allows intentional descent. */
    allowDescend?: boolean;
  };
  /** Facing override. null = keep current facing. */
  facing: 1 | -1 | null;
  /** Fire requests. Empty array = don't fire this tick. */
  fire: FireRequest[];
}

/** Per-fire-request rejection detail returned by the executor. */
export interface FireBlockDetail {
  slot: number;
  reason: "cooldown" | "no-charges" | "angle-blocked" | "dead-weapon" | "cannot-operate" | "invalid-slot";
}

/** Result of executing a UnitCommand, for debug/feedback. */
export interface CommandResult {
  /** Which weapon slots actually fired. */
  firedSlots: number[];
  /** Rejection details for fire requests that were blocked. */
  fireBlocked: FireBlockDetail[];
}
