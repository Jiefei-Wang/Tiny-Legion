/**
 * Canonical logical battlefield width in world units.
 * Used by browser runtime, headless smoke, and arena defaults unless overridden.
 */
export const BATTLEFIELD_WIDTH = 2000;

/**
 * Canonical logical battlefield height in world units.
 * Used by browser runtime, headless smoke, and arena defaults unless overridden.
 */
export const BATTLEFIELD_HEIGHT = 1000;

/**
 * Default ground-lane height ratio of total battlefield height.
 * Example: with height=1000, ground lane uses 400 units.
 */
export const DEFAULT_GROUND_HEIGHT_RATIO = 400 / 1000;

/**
 * Air lane top boundary ratio of total battlefield height.
 * Smaller value means aircraft can fly closer to top edge.
 */
export const AIR_MIN_Z_RATIO = 70 / 1000;

/**
 * Vertical gap ratio between air lane bottom and ground lane top.
 * Preserves visual/logic separation between air and ground layers.
 */
export const AIR_GROUND_GAP_RATIO = 30 / 1000;

/**
 * Tolerance ratio for air-target hit checks on vertical axis.
 * Allows slight Y/Z mismatch when resolving air projectile hits.
 */
export const AIR_TARGET_Z_TOLERANCE_RATIO = 22 / 1000;

/**
 * Minimum effective aircraft max speed required to sustain lift.
 * Aircraft below this threshold enter air-drop/crash behavior.
 */
export const AIR_MIN_LIFT_SPEED = 100;

/**
 * Effective gravity budget aircraft must offset to hold altitude.
 * Higher values require more directed thrust to avoid descent.
 */
export const AIR_HOLD_GRAVITY = 110;

/**
 * Downward acceleration used during forced air-drop/crash behavior.
 */
export const AIR_DROP_GRAVITY = 210;

/**
 * Minimum horizontal speed cap maintained during air-drop state.
 * Prevents stalled crash behavior and keeps return-to-base motion active.
 */
export const AIR_DROP_SPEED_CAP = 260;

/**
 * Scale factor converting directed air thrust into acceleration.
 * Shared by jet/propeller directional movement calculations.
 */
export const AIR_THRUST_ACCEL_SCALE = 70;

/**
 * Additional downward distance threshold for terminating certain ground-fired projectiles.
 * Applies to non-tracking shots fired above horizontal to stop endless off-lane travel.
 */
export const GROUND_PROJECTILE_MAX_DROP_BELOW_FIRE_Y = 200;

/**
 * Fraction of deployment gas refunded when a player unit returns to base alive.
 */
export const BATTLE_SALVAGE_REFUND_FACTOR = 0.6;

/**
 * Converts impulse magnitude into added structure strain in damage model.
 * Larger values make knockback/impact impulses damage structure faster.
 */
export const IMPULSE_DAMAGE_STRESS_FACTOR = 2.2;

/**
 * Global scalar that maps armor rating into projectile penetration cost.
 * Larger values reduce multi-part penetration depth.
 */
export const PENETRATION_ARMOR_SCALER = 2;

/**
 * Master switch for runtime unit-vs-unit soft separation.
 * When disabled, units can stack/overlap without positional correction.
 */
export const UNIT_SEPARATION_ENABLED = true;

/**
 * Maximum allowed overlap as a fraction of the smaller unit radius.
 * Example: 0.35 allows up to 35% small-radius penetration before push-out.
 */
export const UNIT_OVERLAP_ALLOWANCE_RATIO = 0.35;

/**
 * Positional correction gain applied to detected overlap depth each tick.
 * 1.0 fully resolves depth in one pass; lower values are softer and less jittery.
 */
export const UNIT_SEPARATION_POSITION_FACTOR = 0.85;

/**
 * Relative normal-velocity damping factor applied on overlap resolution.
 * 0 means no velocity damping; 1 means full removal of closing normal speed.
 */
export const UNIT_SEPARATION_VELOCITY_DAMPING = 0.55;

/**
 * Broad-phase spatial grid cell size (world units) for separation pair queries.
 * Larger values reduce bucket count but increase candidate pair checks.
 */
export const UNIT_SEPARATION_GRID_SIZE = 120;

/**
 * Number of randomized spawn placement attempts to avoid immediate deep overlap.
 */
export const UNIT_SPAWN_PLACEMENT_ATTEMPTS = 8;
