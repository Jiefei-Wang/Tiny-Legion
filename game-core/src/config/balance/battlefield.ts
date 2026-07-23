import { GAME_CONFIG } from "../generated/game-config.generated.ts";

const config = GAME_CONFIG.balance.battlefield;

/** Canonical logical battlefield width in world units. */
export const BATTLEFIELD_WIDTH: number = config.battlefield.width;

/**
 * Canonical logical battlefield height in world units.
 * Used by browser runtime, headless smoke, and arena defaults unless overridden.
 */
export const BATTLEFIELD_HEIGHT: number = config.battlefield.height;

/**
 * Global multiplier applied to commanded unit movement.
 * This changes unit translation speed without changing lift, gravity, recoil, or projectile physics.
 */
export const DEFAULT_UNIT_MOVEMENT_SPEED_MULTIPLIER: number = config.movement.defaultMultiplier;

/** Supported customization range for the global unit movement speed multiplier. */
export const MIN_UNIT_MOVEMENT_SPEED_MULTIPLIER: number = config.movement.minMultiplier;
export const MAX_UNIT_MOVEMENT_SPEED_MULTIPLIER: number = config.movement.maxMultiplier;

/**
 * Default ground-lane height ratio of total battlefield height.
 * Example: with height=1000, ground lane uses 400 units.
 */
export const DEFAULT_GROUND_HEIGHT_RATIO: number = config.battlefield.groundHeightRatio;

/**
 * Air lane top boundary ratio of total battlefield height.
 * Smaller value means aircraft can fly closer to top edge.
 */
export const AIR_MIN_Z_RATIO: number = config.battlefield.airMinZRatio;

/**
 * Vertical gap ratio between air lane bottom and ground lane top.
 * Preserves visual/logic separation between air and ground layers.
 */
export const AIR_GROUND_GAP_RATIO: number = config.battlefield.airGroundGapRatio;

/**
 * Tolerance ratio for air-target hit checks on vertical axis.
 * Allows slight Y/Z mismatch when resolving air projectile hits.
 */
export const AIR_TARGET_Z_TOLERANCE_RATIO: number = config.battlefield.airTargetZToleranceRatio;

/**
 * Effective gravity budget aircraft must offset to hold altitude.
 * Higher values require more directed thrust to avoid descent.
 */
export const AIR_HOLD_GRAVITY: number = config.air.holdGravity;

/**
 * Downward acceleration used during forced air-drop/crash behavior.
 */
export const AIR_DROP_GRAVITY: number = config.air.dropGravity;

/**
 * Minimum horizontal speed cap maintained during air-drop state.
 * Prevents stalled crash behavior and keeps return-to-base motion active.
 */
export const AIR_DROP_SPEED_CAP: number = config.air.dropSpeedCap;

/**
 * Scale factor converting air-engine power-to-mass into pre-gravity thrust speed.
 */
export const AIR_THRUST_ACCEL_SCALE: number = config.air.thrustAccelScale;

/**
 * Additional downward distance threshold for terminating certain ground-fired projectiles.
 * Applies to non-tracking shots fired above horizontal to stop endless off-lane travel.
 */
export const GROUND_PROJECTILE_MAX_DROP_BELOW_FIRE_Y = config.combat.groundProjectileMaxDropBelowFireY;

/**
 * Fraction of deployment gas refunded when a player unit returns to base alive.
 */
export const BATTLE_SALVAGE_REFUND_FACTOR = config.combat.salvageRefundFactor;

/**
 * Converts impulse magnitude into added structure strain in damage model.
 * Larger values make knockback/impact impulses damage structure faster.
 */
export const IMPULSE_DAMAGE_STRESS_FACTOR = config.combat.impulseDamageStressFactor;

/**
 * Global scalar that maps armor rating into projectile penetration cost.
 * Larger values reduce multi-part penetration depth.
 */
export const PENETRATION_ARMOR_SCALER = config.combat.penetrationArmorScaler;

/** Minimum and maximum world-space size of one rendered/collidable structure cell. */
export const MIN_STRUCTURE_CELL_SIZE = config.structure.minCellSize;
export const MAX_STRUCTURE_CELL_SIZE = config.structure.maxCellSize;

/**
 * Returns the canonical world-space size for a unit's structure cells.
 * Rendering, projectile collision, targeting, and weapon geometry must use this
 * helper so the visible armor panels and their hitboxes stay aligned.
 */
export function getStructureCellSize(unitRadius: number): number {
  return Math.max(MIN_STRUCTURE_CELL_SIZE, Math.min(MAX_STRUCTURE_CELL_SIZE, unitRadius * 0.82));
}

/**
 * Master switch for runtime unit-vs-unit soft separation.
 * When disabled, units can stack/overlap without positional correction.
 */
export const UNIT_SEPARATION_ENABLED = config.separation.enabled;

/**
 * Maximum allowed overlap as a fraction of the smaller unit radius.
 * Example: 0.35 allows up to 35% small-radius penetration before push-out.
 */
export const UNIT_OVERLAP_ALLOWANCE_RATIO = config.separation.overlapAllowanceRatio;

/**
 * Positional correction gain applied to detected overlap depth each tick.
 * 1.0 fully resolves depth in one pass; lower values are softer and less jittery.
 */
export const UNIT_SEPARATION_POSITION_FACTOR = config.separation.positionFactor;

/**
 * Relative normal-velocity damping factor applied on overlap resolution.
 * 0 means no velocity damping; 1 means full removal of closing normal speed.
 */
export const UNIT_SEPARATION_VELOCITY_DAMPING = config.separation.velocityDamping;

/**
 * Broad-phase spatial grid cell size (world units) for separation pair queries.
 * Larger values reduce bucket count but increase candidate pair checks.
 */
export const UNIT_SEPARATION_GRID_SIZE = config.separation.gridSize;

/**
 * Number of randomized spawn placement attempts to avoid immediate deep overlap.
 */
export const UNIT_SPAWN_PLACEMENT_ATTEMPTS = config.separation.spawnPlacementAttempts;
