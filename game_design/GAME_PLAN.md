# 2D Modular Army Game Plan

## 1. Game Vision

Build a 2D strategic-combat game where the player designs modular army units, expands a top-down base, and fights for map control.

- Units have **three layers**:
  - **Structure Layer**: simple cells that hold damage and define survivability.
  - **Functional Layer**: internal modules (engine, weapon, utility) that can be placed inside the structure.
  - **Display Layer**: purely visual shell/skin for readability and style; does not affect physics, armor, or functional performance.
- Player grows from weak starter units (small basic cells) to advanced composite structures and high-tier materials.
- Battles can be fought by direct control or AI automation.
- Every unit has exactly one Control Unit; if it is destroyed, the whole unit becomes non-operational.

---

## 2. Core Gameplay Loop

1. Build and expand base (top-down management).
2. Design/upgrade unit templates in workshop.
3. Select a map node to attack, defend, or occupy.
4. Enter battle and deploy army using global gas resource.
5. Win by occupation or enemy defeat.
6. Click **Next Round** to advance campaign time (gas income/upkeep, construction progress, battle resolution).
7. Station garrison to hold captured territory (gas upkeep per round).
8. Repeat until enemy core base is destroyed.

Lose condition chain:

- Lose a battle if your battle base is destroyed.
- Lose the campaign/game by losing key battles and being outpaced strategically (campaign-end condition TBD).

---

## 3. World and Session Structure

## 3.1 Overworld Map

- Player starts from home base node.
- Player chooses destination nodes (resource sites, strategic zones, enemy sectors).
- Nodes can be:
  - Neutral
  - Player-controlled
  - Enemy-controlled
  - Contested
- Includes a dedicated `Test Arena` top-level tab (parallel to `Battle`) for debug scenarios.
- Test Arena overrides both battle bases to extremely high HP so base destruction does not end the test run.
- Test Arena controls allow setting enemy count, player count, battlefield simulation size (`W`/`H`), ground-zone height, display zoom percentage, selecting enemy and player auto-spawn templates from separate multi-select dropdowns, toggling `auto spawn on enemy side` and `auto spawn on player side` (both default ON), clearing all currently active arena units, and toggling controlled-unit invincibility (no HP loss, still collides and can be hit).
- Test Arena Unit controls are arranged as a `Player`/`Enemy` two-column grid with three rows: count, spawn template, auto-spawn toggle.
- Test Arena auto-spawn behavior: when enabled per side, the game auto-spawns the selected side template whenever alive units drop below the configured count target.
- Test Arena starts with no extra starter units; units only appear through enabled auto-spawn behavior (or explicit deploy actions).
- Battle Ops pane includes a spawn-side switch (`Player Spawn` / `Enemy Spawn`, default `Player Spawn`); enemy-side deploy from this pane is allowed only during active Test Arena.
- Test Arena options panel is organized as collapsible tabs to save space: battle start/stop actions are always in the first row, `Unit` is expanded by default, `AI Selection` is collapsed by default, and `UI Configuration` is grouped in its own tab.
- Test Arena AI presets are local JS/TS-only and run without external Python bridge/service dependencies.
- Test Arena parameter inputs apply on `Enter` or input blur (no separate apply button).
- Test Arena zoom percentage is live-synced when mouse-wheel zoom changes the battlefield view.

## 3.2 Base Layer (Top-Down)

- Buildable area can be expanded by construction.
- Buildings support economy, production, research, and defense.
- Example building categories:
  - Command Center (critical)
  - Gas Refinery/Storage 
  - Factory (unit production)
  - Workshop (unit design unlocks)
  - Research Lab (materials/composite tech)
  - Defense Turret/Shield

---

## 4. Unit Design System (Three-Layer)

Current implementation includes dedicated in-app editor tabs where the player can:

- Open `Template Editor` and `Part Editor` as top-level mode tabs (parallel to `Battle`).
- Use `Template Editor` for full unit template authoring.

- Switch between `Structure`, `Functional`, and `Display` layers from the right-side panel.
- Use a resizable editor grid (up to `10x10`) for placement/removal by cell.
- Choose parts/components from a layer-specific side palette (placeholder image cards + hover info).
- Template Editor structure palette is sourced from file-backed structure parts (via part catalog) by `part.id` (no material-bucket dedupe).
- Template Editor functional palette now applies unit-type compatibility filtering: parts tagged `air` only show for air templates, parts tagged `ground` only show for ground templates, and untagged parts remain available to both.
- Toggle delete mode to remove items on the active layer.
- Open any existing template from an `Open` window, create a template copy using one-click `Copy` (`-copy` postfix), or `Delete` file-backed entries from the same list.
- Template IDs are internal positive integers, auto-generated, and hidden from editor UI (not user-editable).
- Saving a renamed opened template creates a new template identity and deletes the previously opened template entry.
- Stored template parts include coordinate metadata (`x`,`y`) with origin `(0,0)` and negative coordinates supported.
- Functional template entries now persist both `component` and `partId` so user templates can reference developer-authored parts.
- Weapon functional parts store additive orientation (`rotateQuarter`, 0..3 in 90-degree steps).
- Functional placement now uses part footprints from part catalog definitions (instead of hardcoded component-only footprints), and footprint rotation follows `rotateQuarter`.
- Functional parts may declare `directional: true`; only directional parts show direction UI and use rotation controls. Parts without it are undirectional by default.
- Effective facing for directional functional parts is computed as `part.direction` (default facing) + template `rotateQuarter` (user rotation). Template-editor direction arrows and propeller thrust/lift both use this combined facing.
- For propellers, combined facing represents airflow/push direction; actual thrust (including lift contribution) is applied in the opposite direction.
- Functional placement supports `center place on click` mode in template editor (developer/user toggle).
- Editor canvas uses a resizable grid up to `10x10` with right-drag panning.
- Editor viewport input supports right-click delete/erase on the targeted cell; right-click drag still pans (click vs drag), and mouse-wheel zoom is supported in editor views.
- Template Editor shows a 50% alpha placement ghost under the mouse for the currently selected part when the hovered placement is valid.
- Template Editor labels structure part names at cell top and functional anchor parts at cell bottom using `partId + "." + initials` (for example, `18.P` and `16.ML`).
- In Template Editor, right-click delete is staged per cell: delete functional first; if no functional remains, delete structure (and attached display) on the next click.
- Battle and editor views each render to their own canvas while sharing the same viewport window.
- Editor canvas overlays show the current working template/part name at top-left.
- Template Editor bottom-left combat preview shows `Achievable speed` and (for air templates) `Lift` vs hold-gravity threshold.
- First opening an editor view without a valid existing selection starts from an empty editor grid.
- Editor views keep independent pan/view memory; switching tabs restores each view's last camera state.
- Editor view defaults to centered origin (`0,0`) on first load and recenters only when loading a different template/part.
- Battle rendering and hitboxes now honor stored structure/display/functional coordinates instead of compacting to a fixed index grid.
- Template gas cost defaults to the sum of part gas values (structure material parts + functional parts).
- Save templates from editor with a single `Save` action (default storage) and deploy them in battle.
- Saving to default storage (`Save`) removes any user-storage templates with the same template name (case-insensitive), then writes the default template.
- Template Editor shows computed template gas info (sum of part gas values); template-level gas override input is removed.
- Template Editor `Open` window is stratified by unit category (`Ground` then `Air`), each category sorted by total gas ascending, and each row shows template gas.
- Save is allowed even with validation issues.
- Validation is split into `Error` and `Warning` categories:
  - `Error`: severe issues (for example missing control module, air unit cannot hold altitude).
  - `Warning`: spawn-allowed but suboptimal setup (for example no engine for ground unit, no weapon).
- Runtime deployment/spawn gate: templates with any `Error` are blocked from spawning in battle.
- Template schema is strict for structure cells: each cell must provide `partId` that resolves to a `layer: "structure"` part. Legacy `material` fields are not accepted.

### 4.0 Developer Part Designer (Part Editor)

- Developer-only Part Designer is available in the top-level `Part Editor` tab.
- Top-bar `Debug Options` -> `Part Designer` is a shortcut that switches directly to the `Part Editor` tab.
- Part Designer edits a **single reusable part definition** (not a full unit template).
- Part IDs are internal positive integers.

#### 4.0.1 Meaning of Part Types

Canonical part type list:

- `structure`
  - Structural shell and survivability container for a unit.
  - Defines durability/material behavior and structure occupancy.
- `control`
  - Unit command/compute core.
  - Exactly one is required for a valid template.
- `engine`
  - Mobility and thrust provider.
  - Supports ground propulsion and/or air propulsion.
  - Can be directional for air thrust-cone behavior.
- `weapon`
  - Damage/control output module.
  - Handles projectile/beam behavior, firing constraints, and loader dependency.
- `loader`
  - Reload service module.
  - Loads one weapon per cycle using weapon cooldown * load multiplier with minimum load time enforcement.
- `ammo`
  - Shared extra ammunition pool.
  - Can be loaded by free loaders when no weapon is pending load, and can detonate when damaged/destroyed.

#### 4.0.2 Property Meaning

Part-level properties:

- `gas cost`: deployment/resource cost contribution of this part.
- `mass`: mass contribution to unit total mass.
- `tag`: semantic label(s) used by loaders/ammo/category filtering.
- `HP`: part health baseline where applicable.
- `armor`: flat mitigation value (structure-focused).
- `recover`: structure self-recovery per second.
- `color`: structure render/debug color.
- `computing`: control processing capability budget.
- `power assumption`: control-side assumed system power baseline.
- `power`: engine thrust power source, provide power to other parts which has power assumption property.
- `max speed`: engine speed cap contribution.
- `power ground`: engine can provide ground propulsion.
- `power air`: engine can provide air propulsion/lift.
- `directional`:
  - engine: directional air thrust mode.
  - weapon: directional firing mode.
- `default direction`: default facing (`up|down|left|right`) before template rotation.
- `thrust angle`: one-sided directional air-thrust cone half-angle.
- `bullet type`: weapon projectile family (`bullet|missile|laser`).
- `damage`: base hit damage.
- `range`: maximum effective range.
- `cooldown`: base firing cooldown.
- `recoil`: self-impulse on fire.
- `hit impulse`: impulse applied to hit target.
- `penetration`: armor penetration value.
- `spread angle`: random angular spread.
- `explode on hit`: whether projectile explodes on impact.
- `explode radius`: explosive radius.
- `projectile speed`: flight speed for non-laser projectiles.
- `projectile gravity`: gravity/drop for non-laser projectiles.
- `tracking`: projectile can seek targets (non-laser).
- `tracking turn rate`: homing turn acceleration/rate.
- `shoot angle`: one-sided directional shoot cone half-angle (`180` means omni).
- `need loader`: weapon requires loader participation to reload/fire cycle.
- `supported weapon tags`: weapon tags that a loader/ammo can service.
- `load multiplier`: loader time multiplier on weapon cooldown.
- `min load time`: minimum enforced loader cycle time.
- `min burst interval`: minimum interval for burst/charge transfer cadence.
- `max capacity`: ammo storage capacity.
- `explosion damage`: ammo explosion damage.
- `explosion radius`: ammo explosion radius.

Cell-level properties:

- `structure occupy`: occupies structure layer space.
- `functional occupy`: occupies functional layer space.
- `need structure behind`: requires structure support for functional-only cells.
- `take damage`: for non-structure parts, if there is no structure behind the functional part, incoming damage is shared through attached structure points.
- `attach point`: attachment support marker on functional parts; if multiple attach points exist, all must attach to structure.
- `anchor point`: unique part center reference (mouse placement center).
- `fire point`: unique muzzle/spawn point for weapon projectiles.

#### 4.0.3 Part Type Property Set (By Category)

`structure` should expose:

- `gas cost`, `mass`, `HP`, `tag`, `armor`, `recover`, `color`.

`control` should expose:

- `gas cost`, `mass`, `tag`, `computing`, `power assumption`.

`engine` should expose:

- `gas cost`, `mass`, `tag`, `power`, `max speed`, `power ground`, `power air`, `directional` (air only), `default direction`, `thrust angle` (air directional only).

`weapon` should expose:

- `gas cost`, `mass`, `tag`, `bullet type`, `damage`, `range`, `cooldown`, `recoil`, `hit impulse`, `penetration`, `spread angle`, `explode on hit`, `explode radius` (explosive only), `projectile speed` (non-laser), `projectile gravity` (non-laser), `tracking` (non-laser), `tracking turn rate` (tracking only), `directional`, `shoot angle` (directional only), `need loader`, `default direction`.

`loader` should expose:

- `gas cost`, `mass`, `tag`, `supported weapon tags`, `load multiplier`, `min load time`, `min burst interval`.

`ammo` should expose:

- `gas cost`, `supported weapon tags`, `max capacity`, `explosion damage`, `explosion radius`.

#### 4.0.4 Default Values (By Category)

`structure` defaults:

- `gas cost`: `10`
- `mass`: `5`
- `HP`: `25`
- `tag`: `structure`
- `armor`: `0`
- `recover`: `0`
- `color`: `#95a4b8`

`control` defaults:

- `gas cost`: `10`
- `mass`: `2`
- `tag`: `control`
- `computing`: `100`
- `power assumption`: `100`

`engine` defaults:

- `gas cost`: `10`
- `mass`: `10`
- `tag`: `engine`
- `power`: `200`
- `max speed`: `100`
- `power ground`: `true`
- `power air`: `false`
- `directional` (air only): `true`
- `default direction`: `down`
- `thrust angle` (air directional): `30`

`weapon` defaults:

- `gas cost`: `10`
- `mass`: `8`
- `tag`: `weapon`
- `bullet type`: `bullet`
- `damage`: `20`
- `range`: `300`
- `cooldown`: `1.0`
- `recoil`: `10`
- `hit impulse`: `10`
- `penetration`: `0`
- `spread angle`: `0`
- `explode on hit`: `false`
- `explode radius` (explosive only): `50`
- `projectile speed` (non-laser): `400`
- `projectile gravity` (non-laser): `100`
- `tracking` (non-laser): `false`
- `tracking turn rate` (tracking only): `50`
- `directional`: `true`
- `shoot angle` (directional only): `30` (`180` for omni)
- `need loader`: `false`
- `default direction`: `right`

`loader` defaults:

- `gas cost`: `10`
- `mass`: `5`
- `tag`: `loader`
- `supported weapon tags`: `cannon`
- `load multiplier`: `1.0`
- `min load time`: `0.5`
- `min burst interval`: `0.2`

`ammo` defaults:

- `gas cost`: `10`
- `supported weapon tags`: `cannon`
- `max capacity`: `1`
- `explosion damage`: `100`
- `explosion radius`: `100`

#### 4.0.5 Unified Part Editor Behavior (Authoritative)

This subsection is the single source of truth for Part Editor behavior.

File operations:

- `New -> Save`:
  - Creates a new part JSON file.
  - If the draft id collides with an existing part id, the editor auto-allocates a new id before saving.
- `Load -> Save`:
  - Overwrites the existing part JSON for the same id.
- `Load -> Rename -> Save`:
  - Keeps the same id.
  - Deletes the old file path for that id (old name-based filename) and writes a new file using the renamed filename.
- `Load/Select -> Copy -> Save`:
  - Copy creates a new draft with a new id.
  - Save writes a new JSON file for that new id.

Part-level property visibility (left pane):

- Always show:
  - `part name`
  - `part type`
  - `tags`
  - part-type default/common fields (`gas cost`, and other per-type defaults)
- `structure` selected:
  - Show structure-only fields: `mass`, `HP`, `armor`, `recover`, `color`.
  - Hide engine/weapon/loader/ammo-only fields.
- `control` selected:
  - Show: `mass`, `computing`, `power assumption`.
- `engine` selected:
  - Show: `mass`, `power`, `max speed`, `power ground`, `power air`.
  - Show `directional`, `default direction`, `thrust angle` only when air propulsion is enabled (`power air = true`).
- `weapon` selected:
  - Show: `mass`, `bullet type`, `damage`, `range`, `cooldown`, `recoil`, `hit impulse`, `penetration`, `spread angle`, `need loader`, `directional`.
  - Show `projectile speed` and `projectile gravity` only for non-laser bullets.
  - Show `explode radius` only when `explode on hit = true`.
  - Show `tracking` only for non-laser bullets; show `tracking turn rate` only when `tracking = true`.
  - Show `shoot angle` and `default direction` only when `directional = true`.
- `loader` selected:
  - Show: `mass`, `supported weapon tags`, `load multiplier`, `min load time`, `min burst interval`.
- `ammo` selected:
  - Show: `supported weapon tags`, `max capacity`, `explosion damage`, `explosion radius`.

Cell-level property visibility (right pane):

- Always show for selected cell:
  - `structure occupy`
  - `functional occupy`
  - `take damage`
  - `anchor point` (unique)
- Show `need structure behind` only when cell is functional-only (`functional occupy = true` and `structure occupy = false` and not an attach-point-only cell).
- Show `attach point` only for functional parts/cells.
- Show `fire point` only for weapon parts; must be unique per part.

Ghost cell behavior:

- Before left-click placement, the editor renders a ghost cell preview at the hovered grid cell.
- Ghost preview is non-committal (no data mutation until click).
- Valid target: normal ghost style.
- Invalid target: blocked/alert ghost style.

Validation and message placement:

- Part validation produces `Error` and `Warning` severities.
- Message placement in Part Editor:
  - summary counts near the top status/header area of the Part Editor canvas.
  - detailed issue list in the Part Editor canvas issue panel (right-buttom).
- Save is allowed even when warnings/errors are present; messages are still shown so designers can iterate quickly.

## 4.1 Structure Layer (Outer)

Rules:

- Only simple cells and cell combinations.
- Cells connect on a 2D grid.
- Structure receives collision damage first.
- Shape affects hit profile, mass, and handling.

Materials (example):

- Light Steel: cheap, low armor, low mass
- Reinforced Steel: medium armor, medium mass
- Ceramic Composite: high armor vs kinetic, brittle vs explosive
- Reactive Layered Plate: high blast resistance, expensive

### Combined Cell Mechanic

Combined cells are crafted from multiple basic cells/materials and have improved properties.

- Property bonus examples:
  - +durability multiplier
  - +impact distribution efficiency
  - +fire resistance
  - -weight penalty (depends on recipe)

Progression requirement:

- Early game: only Small Basic Cell
- Mid game: unlock material variants
- Later: unlock combined cell recipes and advanced composites

## 4.2 Functional Layer (Inner)

Functional modules are placed inside structure cells. If surrounding structure is breached, modules can be disabled/destroyed.

Attachment rules:

- Every functional component must be attached to at least one structure cell.
- Functional components contribute to **mass** and performance only; they do **not** add armor.
- A detached or destroyed structure cell takes all attached functional components with it.
- A unit can have only one Control Unit.

### Functional Module Catalog
- Mobility
  - Wheel Drive
  - Track Drive
  - Hover Thruster
  - Jet Engine (air units, omni thrust)
  - Propeller (air units, directional thrust)
- Power
  - Engine Core (power output)
  - Battery Pack
- Offense
  - Cannon
  - Machine Gun
  - Rocket Pod
  - Bomb Bay (air)
- Control/Support
  - Control Unit (mandatory, one per unit)
  - Fire Control Unit (accuracy)
  - Armor Repair Unit
  - Radar/Sensor
  - ECM/Jammer
- Logistics
  - Ammo Rack
  - Drone Bay

Design constraints:

- Mass and power budget must be valid.
- Air unit validity rule: at least one engine with `power air = true` is required. Engines with only `power ground = true` do not provide lift/thrust to aircraft.
- Weapon recoil/stability depends on structure and module placement.
- Exposed ammo modules create high-risk weak points.
- The unit blueprint is invalid without exactly one Control Unit.
- Propeller placement rule: multi-cell footprint, clearance area must stay empty, and anchor requires structure support from below.

## 4.3 Display Layer (Visual-Only)

Display layer provides optional visual mesh/sprite styling and silhouette polish.

- Display layer has **zero gameplay authority**:
  - no hitbox contribution
  - no armor contribution
  - no mass contribution
  - no functional contribution
- Physics, collision, damage, and module breakage are evaluated only on Structure + Functional layers.
- Battle display-layer visibility is controlled from top-bar `Debug Options` (`Show Display Layer`), and defaults to `OFF`.
- Editor placement rule: display elements are attached to structure cells only, so display visuals stay on/inside structure bounds.

### 4.4 Template Storage

- Default object designs are file-based under `game/templates/default/`.
- Player-created object designs are stored separately under `game/templates/user/`.
- On startup, game loads templates from both folders (user templates override same-id defaults).
- Template filenames are derived from sanitized `template.name` (invalid filename characters removed); runtime identity remains integer `id`.
- Template parse/validation/merge rules are shared in `packages/game-core/src/templates/template-schema.ts` so game UI and arena tooling use identical template behavior.
- File-backed template load normalizes placement and loader coverage, and normalized JSON is written back to disk so editor, headless checks, and battle runtime read the same corrected shape.
- Loader auto-injection is part of persisted template normalization; injected loaders are placed on available structure cells to avoid overlapping existing functional footprints and existing attachment anchor cells when possible.
- Detailed template validation severity logic is isolated in `packages/game-core/src/templates/template-validation.ts`.
- Headless smoke includes default-template validation to ensure all system default templates are warning/error free.

### 4.5 Part Storage

- Developer default part definitions are file-based under `game/parts/default/`.
- Developer/user part overrides are stored under `game/parts/user/`.
- Canonical default part definitions are explicitly authored in `game/parts/default/*.json` and are being migrated to the new type-centric schema.
- Default templates reference these explicit part IDs in `partId` so runtime/editor behavior matches configured part semantics.
- Runtime part catalog merge order:
  1. file-backed defaults (`game/parts/default`),
  2. user part overrides (`game/parts/user`).
- Part save filenames are derived from part name (illegal filename characters removed); runtime identity remains integer `id`.
- Part Designer save/load/copy/rename behavior is defined in `4.0.5 Unified Part Editor Behavior (Authoritative)`.

---

## 5. Army Capacity and Commander Skill

Commander skill defines max army count globally and in battle.

- `ArmyCap = BaseCap + CommanderSkillLevel * CapPerLevel`
- In battle:
  - Deployment consumes global gas.
  - Active unit count cannot exceed battle cap from commander skill.

Recommended starter values:

- BaseCap: 3
- CapPerLevel: +1 every 2 skill levels
- Battle cap can be temporarily modified by scenario effects.

---

## 6. Battle Rules

## 6.1 General

- Player may directly control any friendly unit at any time.
- Non-controlled units are AI-driven.
- Player can switch controlled unit instantly (short cooldown recommended).
- Strategic layer is round-based: campaign battles resolve at end of round when **Next Round** is pressed (Test Arena ignores round resolution).

## 6.2 Ground Battle Space

- 2D battlefield with left-to-right front.
  - Left: player side/base
  - Right: enemy side/base/buildings
- Battle simulation defaults to a logical battlefield size of `2000x1000` (shared by browser runtime and headless/arena runs).
- Test Arena can override battlefield simulation size at runtime; this changes combat space dimensions, not just display scale.
- Test Arena zoom only changes display scale (camera/view transform), not simulation dimensions.
- Ground units move freely on X and Y axes inside the ground combat zone.
- Ground maneuver is continuous positioning (flank, intercept, disengage), not discrete lane switching.
- Unit-vs-unit body overlap is soft-limited: partial overlap is allowed for flow, but deep/full stacking is resolved by runtime separation.

## 6.3 Air Battle Space

- Air units traverse left-right strategic direction on X, and altitude on Z.
- Air objects do not use ground Y axis for hit eligibility.
- On 2D screen, altitude Z is rendered on vertical axis; combat logic treats air layer separately from ground Y matching.
- Air thrust model:
  - Aircraft use only engines with `power air = true` for movement and anti-gravity.
  - If upward thrust is below gravity, aircraft lose altitude with fall acceleration based on thrust deficit.
  - Unless the player requests descent, flight control prioritizes maintaining altitude and uses spare thrust for horizontal movement.
  - Air movement is thrust-speed driven (direct speed from thrust), not acceleration-ramp driven.
  - When lift becomes critically low, aircraft enter a crash state: they push horizontally toward their base, then use any remaining directional thrust to slow descent; otherwise they fall at full crash gravity and are destroyed on ground impact unless they reach base in time.
- Altitude affects:
  - weapon effectiveness
  - bomb accuracy
  - interception risk
  - visibility/sensor lock

### 6.4 Mouse Aiming and Layered Targeting Rules

- Mouse controls player aim target in battle.
- Hold left mouse is the primary fire action; controlled unit keeps firing all manual-controlled weapon slots toward current mouse aim target.
- Battle viewport keeps the battlefield's original aspect ratio and hides native scrollbars.
- Battle viewport panning controls: keyboard arrow keys and right-click drag.
- Battle viewport supports mouse-wheel zoom (wheel up to zoom in, wheel down to zoom out).
- When a unit is selected/controlled, camera follow nudges the viewport as the unit approaches borders and keeps more look-ahead space in the facing direction.
- Projectiles spawn from the firing weapon module location instead of unit center.
- Unit selection highlight follows outer structure silhouette (not a rectangular bounding box).
- Tracking missile homing reacquires the nearest valid enemy around its intended aim point when needed.
- Loader naming uses `cannonLoader` (legacy `gunLoader` IDs remain load-compatible).
- If left click intersects a friendly object, it selects that object as controlled unit.
- Test Arena uses the same left-click friendly-unit selection rule as regular battle mode.
- When a controlled unit fires, projectile vector is computed toward current mouse aim target.
- Number keys `1..9` toggle per-slot manual weapon control for the currently controlled unit (default `ON` for every weapon slot).
- `Shift+1..9` toggles per-slot auto-fire state.
- Slots under manual control temporarily suppress auto fire without mutating the auto-fire toggle state; auto fire resumes once manual control is disabled for that slot.
- Browser-native `contextmenu` and `dblclick` behaviors are suppressed anywhere inside the game app shell; static UI text in the shell is also non-selectable to prevent double-click highlight effects (form fields remain selectable/editable).
- Keyboard Space flips controlled unit facing direction instantly (forward/backward orientation swap).
- Ground vs ground attacks use Y-axis tolerance (`abs(y1 - y2) <= tolerance`) so exact alignment is not required.
- Air targets are treated as same Y axis for hit eligibility checks.
- Ground cannon rounds can pass through multiple air targets along X path (piercing air layer).
- Enemy units should engage from weapon distance and should not win by direct body contact with player base.
- Ground combat zone is rendered with a visible grid, and aircraft minimum altitude must remain above this grid zone.
- During battle, developer debug tools can switch **Display Layer ON/OFF** from top-bar `Debug Options`.
- Developer debug tools can enable **Show Part HP Overlay** to visualize per-structure-cell remaining HP with red damage tint and numeric HP text.

---

## 7. Combat and Damage Model (2D Physics-Driven)

No simple fixed hitpoint exchange for whole units. Damage emerges from impacts, penetration, and module failure.

- There is **no object-level HP bar** for units.
- Unit kill state is caused by structural breakup and/or critical functional loss (especially Control Unit failure), not by a single aggregated HP pool.
- Broken debris must come from actual destroyed structure/functional parts (no fake-only VFX substitution).
- Ground unit debris stays where it breaks in ground zone; it does not fall to screen bottom.
- Air unit debris falls down with Y-axis gravity until reaching ground zone.

## 7.1 Damage Pipeline

1. Collision/projectile contact on structure cell.
2. Compute local impact energy and contact impulse.
3. Compare vs material resistance.
4. Apply structural damage, crack, or breach on the impacted local structure cell (when a sweep intersects multiple cells in one tick, use the earliest intersection along projectile travel).
5. If breach occurs, inner functional modules can be hit.
6. If structure is detached, all attached modules are removed with it.
7. Module damage creates performance penalties or critical failure.
8. Connectivity rule: any structure cluster disconnected from the single control unit is destroyed immediately.
9. Armor is applied as flat damage deduction per impacted cell: `damageAfterArmor = incomingDamage - cellArmor`, `effectiveDamage = damageAfterArmor <= 0 ? 1 : damageAfterArmor`.
10. Hit impulse still applies physical response (knockback/vibration) even on low/fully mitigated hits.
11. Projectile penetration is tracked separately from damage:
   - each shot starts with weapon `penetration`,
   - per-hit cost is `(cellArmor * PENETRATION_ARMOR_SCALER) + cellCurrentHPBeforeDamage`,
   - projectile continues only while `remainingPenetration > 0`,
   - penetration does not scale damage amount.

Structure durability recovery:

- Each structure material has a `recover per second` value.
- Surviving structure cells gradually recover strain over time.

## 7.2 Suggested Simplified Formula Set

- `ImpactEnergy E = 0.5 * m_eff * v_rel^2`
- `Stress = E / contactArea`
- `Penetration if Stress > MaterialPenThreshold`
- `ResidualDamage = max(1, IncomingDamage - ArmorFlatReduction)` (minimum `1` when armor fully negates or exactly matches incoming damage)

Velocity/knockback and recoil formulas:

- `deltaV_hit = J_hit / M_total`
- `deltaV_recoil = J_recoil / M_total`
- `v_new = v_old + deltaV_hit - deltaV_recoil_along_barrel_axis`

Where:

- `J_hit` = incoming impact impulse from enemy hit (motion response only; not additional structural damage by itself)
- `J_recoil` = impulse generated when firing
- `M_total` = current unit mass (structure + all surviving functional components)

Design effect:

- Lighter units get pushed more by hits and recoil.
- Heavier units resist knockback but pay mobility cost.
- Losing heavy structure/modules changes mass in real time, so post-damage handling shifts naturally.

Module outcomes:

- Engine damaged -> reduced speed/power
- Weapon damaged -> jam/misfire/disabled
- Ammo rack hit -> explosion chain risk

Control Unit outcome:

- Control Unit destroyed -> unit loses command/control and is treated as mission-killed.

## 7.3 Why This Works

- Keeps structure simple (cells) while enabling deep outcomes.
- Makes placement and armor layering meaningful.
- Supports readable battle feedback and player learning.

## 7.4 Hit Reaction and Vibration Effects

Goal: show strong physical feedback without overloading CPU.

Recommended layered approach:

1. Core simulation (authoritative): impulse-based movement (`deltaV = J / M`).
2. Cheap visual shake (default): sprite/rig transform jitter + damped spring return.
3. Optional high quality mode: per-part secondary motion and screen-space shock effects.

Suggested simple vibration model:

- `offset(t) = A * exp(-d * t) * sin(w * t)`
- `A` scales with normalized impact impulse.

Performance guidance:

- Keep gameplay physics on CPU (deterministic and debuggable).
- Start vibration as a visual effect only (no extra collision solves).
- Batch visual effects on GPU (instancing/particle shaders) when unit count rises.
- Add quality tiers:
  - Low: hull-only shake
  - Medium: hull + weapon shake
  - High: per-structure-chunk shake + richer particles

---

## 8. AI Plan

## 8.1 AI Roles

- Assault
- Defender
- Artillery support
- Interceptor (air)
- Harasser/flanker

## 8.2 AI Decision Layers

1. Strategic: objective choice (push base, destroy tower, protect ally)
2. Tactical: route, engagement distance, focus target
3. Control: movement and fire timing

## 8.3 AI Awareness Inputs

- Own structure integrity and module status
- Enemy weak-point exposure
- Local spatial pressure (ground Y spread, air altitude spread) and ally positions
- Gas economy pressure (reinforcement timing)

## 8.4 AI Behaviors to Include Early

- Retreat when engine or armor integrity is too low
- Focus fire on exposed weapon/engine modules
- Ground reposition when local Y corridor is over-defended
- Air altitude optimization for attack/survival

---

## 9. Territory, Occupation, and Defense

Battle rewards:

- Occupy strategic area, or
- Eliminate enemy force/objective

Post-battle occupation:

- Player can station army to protect captured area.
- Stationed force consumes gas upkeep per round.
- Enemy can counterattack occupied zones.

Strategic tension:

- Expanding too quickly can overextend gas upkeep.
- Defensive depth and logistics become as important as offense.

---

## 10. Economy and Resource Model

Primary global resource: **Gas**

- Strategic economy is turn-based: gas income/upkeep is applied only when the player clicks **Next Round**.

Gas used for:

- Deploying new army objects in battle
- Operating stationed garrisons
- Possibly high-upkeep unit abilities

Recommended balancing principles:

- Gas income scales with owned infrastructure/territory.
- Deployment costs should enforce meaningful timing choices.
- Upkeep prevents infinite map spam.

---

## 11. Progression Plan

## 11.1 Early Game

- Small basic cell only
- Basic engine + machine gun modules
- Small squad cap
- Focus: learn structure protection and module placement

## 11.2 Mid Game

- Unlock new materials and medium modules
- Unlock route-specialized unit archetypes
- Unlock base expansion and advanced workshops

## 11.3 Late Game

- Unlock combined cell recipes and advanced composites
- Unlock high-impact weapons and elite commander skills
- Multi-front defense and high upkeep pressure

---

## 12. MVP Scope (First Playable)

Include:

- Overworld with a few connected nodes
- Top-down base with limited building set
- Unit designer with three layers (structure + functional + optional display)
- Ground battle mode with continuous Y movement zone
- Air unit altitude system (simplified)
- Commander-based army cap
- Gas-based in-battle reinforcement
- AI for movement, targeting, and retreat
- Victory/defeat and occupation flow

Exclude for MVP:

- Too many materials or module types
- Complex weather systems
- Full diplomacy/faction mechanics

---

## 13. Implementation Notes (2D Performance)

- Use fixed timestep simulation for deterministic combat feel.
- Use broad-phase collision grid for cells and projectiles.
- Pool projectiles, effects, and destroyed fragments.
- Keep structure destruction cell-based, not pixel-fracture.
- Run AI updates at lower frequency than physics where possible.
- Cap active units/effects based on commander and quality settings.
- Keep recoil/knockback strictly impulse-based so mass changes are cheap to compute.
- Recompute `M_total` incrementally on part loss, not by full blueprint scan every frame.
- Implement vibration as GPU-friendly visual pass first, then scale fidelity by graphics preset.

### 13.1 Current Implementation Snapshot (Living)

The current playable implementation already includes:

- Ground XY movement and air XZ movement abstraction.
- Battle bases auto-place vertically from runtime lane bounds (midpoint of the air/ground boundary band between `airMaxZ` and `groundMinY`), and reflow when battlefield size or ground height changes.
- On battle start, viewport Y is auto-centered to the player-base vertical midpoint using current base world Y and viewport height (X offset remains unchanged).
- Structure/functional/display layer split with debug-menu display toggle (default display OFF) and optional per-cell part HP overlay.
- Multi-weapon units and independent weapon cooldown timers.
- Weapon slot manual-control toggles (default `ON`) and per-slot auto-fire toggles.
- Player-controlled manual slots fire together and runtime-suppress auto fire while keeping the auto toggle state intact.
- Weapon classes are standardized to: rapid-fire, heavy-shot, explosive, tracking, beam-precision, and control-utility.
- Out-of-angle firing is clamped to the nearest allowed weapon-angle boundary, so shots still fire at edge angle.
- Engine modules now provide explicit power; object mobility scales proportionally with total engine power and inversely with current mass.
- Each engine type also defines a max-speed cap. With multiple engines, cap is aggregated by power-weighted average, and real speed is power-to-mass based but never exceeds aggregated max speed.
- Aircraft must satisfy a minimum reachable-speed threshold of `100` (based on computed max speed). If not (including no-engine cases), they lose lift, fall, and crash at a random ground-lane Y.
- Heavy-shot/explosive/tracking weapons now use loader modules and charge-based firing:
  - Loaders process one supported weapon at a time.
  - Player-controlled selected weapon is prioritized for loading.
  - Loader `loadMultiplier` + `fastOperation` modify load time, bounded by `minLoadTime`.
  - Loader `storeCapacity` allows charge overfill (burst behavior), with minimum burst interval floor of `0.5s`.
  - Fire commands sent to a cooling/reloading weapon slot are ignored (no projectile and no recoil/knockback side effects).
- Part-level functional overrides now drive runtime behavior for all current functional families:
  - weapon parts can override recoil/hit impulse, projectile speed/gravity, explosive blast/fuse parameters, tracking turn rate, and control-impair tuning;
  - loader parts can override supported weapon classes and loader timing/capacity parameters;
  - armor `hp` metadata is translated into effective attachment durability scaling.
- Projectile gravity, range-limited lifetime, and debris persistence.
- Ground-vehicle-fired non-tracking projectiles now auto-terminate after falling `200` Y-units below their firing Y origin only when the shot was fired above horizontal (`initialVy < 0`); downward-fired shots are excluded. Termination triggers blast when explosive data exists.
- Runtime now applies soft same-layer unit separation (ground-ground, air-air) with overlap allowance, inverse-mass push-out, and broad-phase spatial grid lookup to prevent full unit stacking while preserving movement flow.
- AI split into targeting, movement, and shooting modules with a shared composite interface in `packages/game-core/src/ai/composite/`.
- Baseline combat AI now runs through `createCompositeAiController(...)` (target -> movement -> shoot), and the legacy decision-tree entrypoint is kept as a compatibility wrapper.
- Baseline shoot AI now receives per-slot runtime fire inputs from battle runtime (`effectiveRange`, resolved projectile speed/gravity, and world-space firepoint), and no longer assumes a global projectile model.
- Baseline shoot AI range gating is evaluated from each weapon firepoint (not unit center), and ballistic solve now compensates for runtime semi-implicit projectile integration to reduce long-range edge-angle misses under gravity.
- Player-side auto-fire now uses the same composite fire-decision pipeline as AI-controlled units (manual-controlled slots still suppress auto fire).
- Baseline shoot prediction keeps movement lead enabled but now applies anti-jitter damping: filtered target velocity (EMA), partial lead-gain scaling (distance + acceleration guard), plus per-weapon angle deadband and slew-rate limiting.
- Runtime now records per-unit target history samples (last 10 `(x,y)` positions across a 1-second window) using time-interval sampling (`sampleInterval = window / samples`) rather than frame-count assumptions.
- Added a separate composite shoot module family `history-shoot` that estimates target movement from weighted history points (`(1..10)/sum(1..10)`, newest highest) and feeds that estimate into ballistic aim, so it can be compared directly against baseline in Test Arena/arena runs.
- Added a separate composite shoot family `autoreg-shoot` with autoregressive velocity estimate `v_hat = (1 - alpha) * old_v_hat + alpha * current_v` (`alpha` from module params).
- Added trainable composite shoot families `history-shoot`, `w11-shoot`, and `autoreg-shoot` for arena optimization (`history-shoot` trains `history.recencyPower`; `autoreg-shoot` trains `alpha`; `w11-shoot` trains `alpha1..alpha11` as direct non-negative weights (no sum-to-1 normalization) and uses interval-averaged history segment velocities only, without instantaneous velocity input).
- Angle deadband + slew-rate damping is applied only in `baseline-shoot` (`baseline-game-ai`); `history-shoot`, `autoreg-shoot`, and `w11-shoot` use direct per-tick ballistic aim angles without AI-side angle-change clamping.
- Leaderboard model pool no longer auto-injects built-in autoreg alpha-sweep entries; autoreg leaderboard entries now come from saved trained runs.
- Target module returns ranked targets (sorted by importance); movement consumes ranked targets + battlefield state; shooting consumes ranked targets + movement intent + weapon readiness.
- AI shot-feedback correction has been removed; baseline/composite firing now uses direct ballistic solve + runtime angle constraints without per-shot adaptive aim-offset accumulation.
- Arena supports composite module wiring (`target/movement/shoot`) so each module can be replaced and compared independently.
- Arena headless match specs are composite-only (`familyId: "composite"`); baseline behavior is represented as a baseline composite bundle rather than a standalone AI family.
- `dt-shoot` now exposes additional trainable angle-feature parameters: `weaponSpeed` (for standardized relative distance), plus weighted terms over `stdX`, `stdY`, `stdY/stdX`, and `stdY/(stdX^2)` to bias final firing angle.
- Added `dt-shoot-atan` shoot family: it keeps the same strategy/range/integrity gates as `dt-shoot` but uses `atan2`-based angle features for correction to avoid vertical-shot singularities when `dx` is near zero.
- `dt-shoot` angle adjustment is now passed through without pre-clamping in AI module logic; runtime fire/control execution remains the source of angle constraint enforcement.
- Composite compare/optimization runs in phased sequence:
  - Phase 1: no-base 1v1 (shoot/movement only)
  - Phase 2: no-base NvN
  - Phase 3: full battlefield with bases
  - Phase 4: leaderboard-nearby ladder (`p4-leaderboard`) where candidates are evaluated against saved models whose Elo scores are closest to current candidate reference score.
- Composite phase scenarios are configurable in `arena/composite-training.phases.json`, including per-phase template-name filters with wildcard support (`*`) and battlefield sizing (`width`, `height`, optional `groundHeight`).
- Test Arena includes a `2 x 3` AI component grid (player/enemy x target/movement/shoot), and each cell is a single dropdown for quick switching.
- Test Arena AI Selection now includes per-side composed-model selectors (saved leaderboard runs + built-ins); selecting a composed model applies the full target/movement/shoot bundle for that side.
- Each dropdown lists built-in module options plus all saved module specs discovered from arena run artifacts (`arena/.arena-data/runs/*/best-composite.json`).
- Grid changes apply immediately (no manual apply step).
- Left-side mode menu includes a dedicated `Leaderboard` screen (new row in the mode grid) that shows ranked composite run scores.
- Leaderboard rating is match-based: each composite run starts at score `100`, then head-to-head results adjust both models using an Elo-style expected-outcome update (larger score gaps produce larger swing factors).
- Leaderboard competition runtime uses `p4-leaderboard` scenario settings from `arena/composite-training.phases.json` (template filters + battlefield size/ground-height), so rank battles align with training phase-4 conditions.
- Elo uses pairwise diminishing-K updates (same two models -> progressively smaller K), which naturally converges under repeated head-to-head loops without hard score caps.
- Leaderboard panel includes quick competition controls: `random pair`, `unranked vs random`, and `manual pair` modes plus configurable run count.
- Leaderboard model pool includes built-in composed models for `baseline-game-ai` (`baseline-target` + `baseline-movement` + `baseline-shoot`) and `baseline-history-shoot-ai` (`baseline-target` + `baseline-movement` + `history-shoot`) so both baseline shooters are ranked directly against trained runs.
- Leaderboard `Run Competition` submits a batched request and executes rounds in parallel across CPU worker threads (all detected cores when worker runtime is available), then refreshes leaderboard/model lists after completion.
- Test Arena module-selection contract is documented in `game/AI_COMPONENT_CONFIG.md`.
- Training automation script `train_ai.sh` provides module-specific optimization (`shoot`/`movement`/`target`) and full compose optimization (`compose`) with per-module source selection (`baseline|new|trained:<path>`).

Current gaps still being iterated:

- Further balancing of baseline composite aggressiveness vs survivability.
- More advanced anticipation for abrupt target acceleration changes.
- Further balancing of AI burst cadence vs player cadence.

---

## 14. Win/Lose Summary

- **Battle win**: occupy objective area or defeat enemy force/objective.
- **Battle loss**: player battle base destroyed.
- **Campaign loss**: TBD (no global base HP).

This keeps the game focused on engineering + tactics + logistics, with clear stakes from skirmish level to full campaign failure.

---

## 15. Debug Workflow (Developer + Agent)

Runtime debug options are available in-app:

- `Unlimited Resources`
- `Draw Path + Hitbox`
- `Draw Target Lines`

When visual debug is ON, battle HUD shows live AI telemetry (state, target, angle, range, velocity).

Local file logging in dev mode:

- Toggle endpoint: `POST /__debug/toggle`
- Write endpoint: `POST /__debug/log`
- Log output: `game/.debug/runtime.log`

Recommended startup for debug sessions:

```bash
DEBUG_LOG=1 npm --prefix game run dev
```

---

## 15. Starter Balancing Tables (Initial Tuning)

These values are intentionally conservative for first playable builds. Tune by telemetry after internal playtests.

## 15.1 Recoil and Hit Impulse by Weapon Class

Use:

- `deltaV = J / M_total`
- `J` unit: kN*s (treat as tuning scalar in gameplay units)

| Weapon Class | Fire Impulse `J_recoil` | Typical Reload | Direct Hit Impulse `J_hit` | Notes |
| --- | ---: | ---: | ---: | --- |
| Light MG | 1.2 | 0.10 s | 0.8 | Stable suppression, low knockback |
| Heavy MG | 2.4 | 0.16 s | 1.5 | Noticeable recoil on light chassis |
| Light Cannon | 8.0 | 1.40 s | 6.0 | Core early anti-armor gun |
| Medium Cannon | 14.0 | 2.20 s | 11.0 | Strong pushback and breach potential |
| Heavy Cannon | 22.0 | 3.10 s | 18.0 | Demands wide/heavy structure support |
| Rocket Pod (single) | 9.0 | 0.55 s | 10.0 | Blast-focused, higher module disruption |
| Bomb Bay (light) | 0.0 | 2.80 s | 14.0 | No recoil to self, large ground shock |

Quick sanity examples:

- If `M_total = 40` and `J_recoil = 8.0`, then `deltaV_recoil = 0.20`.
- If `M_total = 120` and `J_recoil = 8.0`, then `deltaV_recoil = 0.067`.

This preserves your desired physical rule: heavier units move less.

## 15.2 Structure Material Starter Properties

`ArmorResist` and `PenThreshold` are used in damage checks. `Density` feeds mass.

| Material | Density (mass/cell) | ArmorResist | PenThreshold | BlastResist | Cost/cell | Unlock Stage |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Basic Steel Cell | 1.00 | 1.00 | 1.00 | 1.00 | 10 | Start |
| Reinforced Steel Cell | 1.30 | 1.35 | 1.25 | 1.10 | 18 | Early-Mid |
| Ceramic Composite Cell | 0.90 | 1.25 | 1.45 | 0.85 | 24 | Mid |
| Layered Reactive Cell | 1.45 | 1.55 | 1.30 | 1.60 | 34 | Mid-Late |
| Combined Cell Mk1 | 1.25 | 1.50 | 1.40 | 1.25 | 30 | Mid |
| Combined Cell Mk2 | 1.55 | 1.80 | 1.65 | 1.50 | 46 | Late |

Combined cell rule (starter):

- Combined cells require recipe materials and workshop level.
- They gain a global bonus: `+15% durability`, `+10% stress distribution`.

## 15.3 Functional Component Mass and Vulnerability (Starter)

Functional components add mass and capability, but no armor.

| Component | Mass | HP Multiplier vs Structure Cell | On Destroyed Effect |
| --- | ---: | ---: | --- |
| Control Unit | 8 | 0.9 | Unit mission-killed |
| Engine Core (small) | 10 | 1.0 | -45% thrust/power |
| Engine Core (medium) | 16 | 1.0 | -60% thrust/power |
| Ammo Rack | 7 | 0.8 | 30% secondary explosion chance |
| Fire Control Unit | 6 | 0.9 | +35% weapon spread |
| Radar/Sensor | 5 | 0.9 | Reduced detection range |

Attachment enforcement:

- If host structure cell detaches, all attached functional components are removed instantly.

## 15.4 Vibration/Hit-Reaction Performance Presets

Vibration is visual-first; gameplay physics remains impulse-based.

| Preset | Per-Hit Visual Model | Max Units With Full Effect | CPU Budget Target | GPU Budget Target | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| Low | Hull-only damped shake | 200 | <0.4 ms/frame | <0.3 ms/frame | Best for low-end devices |
| Medium | Hull + weapon shake + small particles | 120 | <0.8 ms/frame | <0.8 ms/frame | Default |
| High | Per-structure-chunk shake + richer particles | 70 | <1.6 ms/frame | <1.8 ms/frame | Desktop/high-end |

Starter vibration formula:

- `offset(t) = A * exp(-d * t) * sin(w * t)`
- Recommended defaults: `d = 14`, `w = 38`.
- `A = clamp((J_hit / M_total) * 0.9, 0, A_max)`.

GPU acceleration guidance:

- Start with CPU transform updates for low entity counts.
- Move secondary shake/particles to GPU instancing when average simultaneous hit effects exceed 150.
- Keep deterministic gameplay states off GPU to avoid sync complexity.

## 15.5 Commander Cap and Gas Starter Values

| Parameter | Starter Value | Notes |
| --- | ---: | --- |
| Base Army Cap | 3 | At commander skill 1 |
| Cap Growth | +1 every 2 skill levels | Rounded down |
| Battle Active Cap | `ArmyCap` | Hard limit per battle |
| Unit Call-In Gas Cost | 18 to 65 | By unit tier/mass |
| Garrison Upkeep | 4 gas/round/unit | Paid each round while stationed |
| Base Passive Gas Income | 20 gas/round | Before expansion bonuses |

Balancing guardrails:

- Average call-in cadence target: one mid unit every 1 to 3 rounds.
- If matches snowball too hard, raise garrison upkeep before increasing call-in cost.
