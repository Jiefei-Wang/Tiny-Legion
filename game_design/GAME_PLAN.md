# 2D Modular Army Game Plan

## 1. Game Vision

Build a 2D strategic-combat game where the player designs modular army units, expands a top-down base, and fights for map control.

- Units have **three layers**:
  - **Structure Layer**: simple cells that hold damage and define survivability.
  - **Functional Layer**: internal modules (engine, weapon, utility) that can be placed inside the structure.
  - **Display Layer**: purely visual shell/skin for readability and style; does not affect physics, armor, or functional performance.
- Player grows from weak starter units (small basic cells) to advanced composite structures and high-tier materials.
- Battles can be fought by direct control or AI automation.
- Units can have one or more Control Units.
- A unit is non-operational when no Control Unit remains alive.

---

## 2. Core Gameplay Loop

1. Configure the main base's four building spots (two small, two medium).
2. Design/upgrade unit templates in workshop.
3. Select a map node to attack, defend, or occupy.
4. Enter battle and deploy army using global gas resource.
5. Win by occupation or enemy defeat.
6. Campaign time advances continuously: income, construction, research, deliveries, and battles all progress in real time.
7. Capture resource/oil fields, outposts, and remote bases to improve income and logistics.
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
- Test Arena controls allow setting both bases' HP, enemy count, player count, battlefield simulation size (`W`/`H`), ground-zone height, display zoom percentage, selecting enemy and player auto-spawn templates from one shared two-column craft expansion, toggling `auto spawn on enemy side` and `auto spawn on player side` (both default ON), clearing all currently active arena units, and toggling controlled-unit invincibility (no HP loss, still collides and can be hit).
- Test Arena defaults to four auto-spawned units per side with every available craft type selected for both sides. Its counts, craft selections, toggles, battlefield configuration, AI selections, and manual-spawn choices auto-save locally and restore when the game is opened again.
- Test Arena Unit controls keep Player/Enemy count and auto-spawn controls side by side; opening the single `Craft types` expansion reveals both sides' checkboxes together for every craft.
- Test Arena auto-spawn behavior: when enabled per side, the game auto-spawns the selected side template whenever alive units drop below the configured count target.
- Test Arena starts with no extra starter units; units only appear through enabled auto-spawn behavior (or explicit deploy actions).
- Battle Ops pane includes a spawn-side switch (`Player Spawn` / `Enemy Spawn`, default `Player Spawn`); enemy-side deploy from this pane is allowed only during active Test Arena.
- Test Arena options panel is organized as collapsible tabs to save space: battle start/stop actions are always in the first row, `Unit` is expanded by default, and `Manual Spawn`, `AI Selection`, and `UI Configuration` are collapsed by default. `Manual Spawn` deploys exactly one chosen craft immediately for either Player or Enemy during an active Test Arena.
- Developer-only destinations (`Test Arena`, `Leaderboard`, `Craft Designer`, `Part Designer`, and `Global Settings`) live in the top-bar `Developer Tools` dropdown. The campaign sidebar is reserved for Base/Map/Battle, and its navigation/panel split can be dragged vertically and is persisted locally.
- Runtime debug controls live in a compact top-bar dropdown that matches the `Developer Tools` trigger and popover presentation.
- The development-only Global Settings authoring panel exposes every game-core YAML setting through top-level category tabs (`Balance`, `AI`, `Display`, `Editor`, and `Sound`), file-level sections, and recursively nested subcategories. The modal occupies a stable 90% of the viewport height and scrolls its settings content internally instead of resizing as groups expand. File sections and nested subcategories are collapsed by default so opening the panel shows only its navigational headers, except that a category containing exactly one file section expands that section automatically. Type-aware controls edit numbers, booleans, text, and arrays; hovering a field or focusing its help marker shows the explanation authored in that YAML document's `_descriptions` map. Sound sample paths and fire-sample pools each include a preview button that uses the current unsaved form values, with pool previews choosing a member at the authored weapon-class playback rate. Saving validates and transactionally rewrites the fixed YAML set under `game-core/src/config/` while retaining the descriptions; movement speed and master battle volume apply immediately through explicit live hooks, while other settings take effect after restarting the affected VIP/Arena runtime. These values are not browser-local preferences.
- Test Arena AI presets are local JS/TS-only and run without external Python bridge/service dependencies.
- Browser battles are presented by Phaser while the shared simulation remains renderer-independent for headless training and verification.
- Test Arena parameter inputs apply on `Enter` or input blur (no separate apply button).
- Test Arena zoom percentage is live-synced when mouse-wheel zoom changes the battlefield view.
- Test Arena shows live upper-left loss totals for each side: destroyed craft count and the authored gas value wasted by those destroyed craft. Clearing units or withdrawing them does not count as destruction.

## 3.2 Base Layer (Top-Down)

- The player has exactly one buildable Main Base, presented as a graphical compound around a permanent Command Core.
- The Main Base has four limited spots: two `small` and two `medium`. A building must match its spot size, and occupied/in-progress spots cannot accept another project.
- Small buildings are Gas Refinery (requires the main-base gas deposit; continuous income) and Research Lab (enables timed research).
- Medium buildings are Workshop (craft fabrication/design support) and Delivery Center (adds three simultaneous friendly battle slots; base capacity is two).
- Buildings consume gas when queued and complete after real-time durations from 35 to 60 seconds. Research also consumes gas and takes 55 to 85 seconds.
- Construction, research, income, and battles continue while the player views Base, Map, or an off-screen campaign battle.
- Base Command shows the live compound, building size, construction state, delivery capacity, continuous income, and project timers.
- Main Base presentation uses a hand-painted top-down compound scene with a fortified Command Core, roads, perimeter terrain, visibly different small/medium pads, and facility portraits anchored directly to their pads. Facility interaction overlays remain compact so the scene reads as a place before its labels are read.
- The compound is the first and dominant Base view: reserves, facility count, delivery capacity, project count, and status are compact overlays on the scene instead of content that pushes it below the fold.
- Empty pads are selected directly in the compound. The selected pad drives a shared bottom construction palette, inspired by classic RTS command panels, that shows only buildings compatible with that pad size.

## 3.3 Strategic Map Interface

- The Map is a branching routed graph with battlefields, resource fields, oil fields, outposts, remote bases, and the enemy core.
- Resource/oil fields add continuous per-minute income when controlled.
- Controlled outposts provide their listed craft for free inside their support range.
- Captured remote bases have no building spots. They become forward logistics origins, reducing distance, travel time, and distance cost to nearby battlefields.
- The player may have only one active campaign battle. That battle continues in real time while the player views Base or Map.
- The battle panel starts with three craft selected for off-screen AI logistics. The player can change this roster; when gas and delivery capacity permit, AI dispatches from it while the player is outside the battlefield.
- Manual and AI dispatches enter an en-route queue. ETA is based on craft movement speed and distance from the nearest Main/remote base; distance also adds a bounded gas multiplier.
- Strategic Map presentation uses a hand-painted terrain theater with compact ownership/resource markers, landmark-aligned positions, animated route signals, and safe edge padding instead of persistent rectangular node cards.
- The map layout adapts from a wide routed network to a vertically readable compact arrangement.

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
- Functional parts may declare `directional: true`, meaning placement rotation also rotates their functional aiming/facing direction. Craft Editor footprint rotation is independent: `Q`/`E` can rotate any directional part or multi-cell functional part, including non-directional control units and engines.
- For weapon parts with `directional: false`, runtime firing facing stays fixed to the part's base `direction`, even if a multi-cell footprint is rotated for placement.
- Effective facing for directional weapon parts is computed as `part.direction` (default facing) + template `rotateQuarter` (user rotation).
- Functional placement supports `center place on click` mode in template editor (developer/user toggle).
- Editor canvas uses a resizable grid up to `10x10` with right-drag panning.
- Editor viewport input supports right-click delete/erase on the targeted cell; right-click drag still pans (click vs drag), and mouse-wheel zoom is supported in editor views.
- Template Editor shows a 50% alpha placement ghost under the mouse for the currently selected part when the hovered placement is valid.
- Hovering an occupied Craft Designer grid cell shows the structure block name and, when present, the functional block name. Every occupied cell of a multi-cell functional part resolves to that part's name, not only its anchor cell.
- The Craft Inspector groups its complete functional-part palette by Part Designer type (`Control`, `Engine`, `Weapon`, and `Loader`), including all compatible control-unit sizes. Battle-only Mission Log and Controls drawers are hidden on designer screens.
- The Craft Inspector fills the right-side height with its part palette. Craft counts and material/direction status live in a compact canvas readout at the upper-right; validation remains only in the lower-right; concise interaction hints remain only in the bottom HUD, including explicit `Q` counterclockwise and `E` clockwise rotation guidance for directional parts.
- Placing a selected structure part on an occupied structure cell replaces that cell's material and visible name immediately, while applying the chosen block tint.
- Missing structure behind a functional part is a soft Craft Editor constraint: the editor permits preview and placement, reports the missing support as a template validation error, and still permits saving so structure can be added later. Bounds, functional overlap, and required-clearance conflicts remain hard placement blockers.
- Template Editor labels structure part names at cell top and functional anchor parts at cell bottom using `partId + "." + initials` (for example, `18.P` and `16.ML`).
- In Template Editor, right-click delete is staged per cell: delete functional first; if no functional remains, delete structure (and attached display) on the next click.
- Battle and editor views each render to their own canvas while sharing the same viewport window.
- Editor canvas overlays show the current working template/part name at top-left.
- Template Editor bottom-left combat preview shows post-gravity `Achievable speed` and (for air templates) air thrust vs gravity.
- First opening an editor view without a valid existing selection starts from an empty editor grid.
- Editor views keep independent pan/view memory; switching tabs restores each view's last camera state.
- Editor view defaults to centered origin (`0,0`) on first load and recenters only when loading a different template/part.
- Battle rendering and hitboxes now honor stored structure/display/functional coordinates instead of compacting to a fixed index grid.
- Destroying a structure cell never recenters surviving rows or attached visuals: every layer remains anchored to the craft's original coordinate grid, and the craft's battlefield position is unchanged.
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
- `weapon`
  - Damage/control output module.
  - Handles projectile/beam behavior, firing constraints, and loader dependency.
- `loader`
  - Reload service module.
  - Loads one weapon per cycle using weapon cooldown * load multiplier with minimum load time enforcement.

#### 4.0.2 Property Meaning

Part-level properties:

- `gas cost`: deployment/resource cost contribution of this part.
- `mass`: mass contribution to unit total mass.
- `tag`: semantic label(s) used by loaders and category filtering.
- `HP`: part health baseline where applicable.
- `armor`: flat mitigation value (structure-focused).
- `recover`: structure self-recovery per second.
- `color`: structure render/debug color.
- `transparency`: per-block render alpha from `0` (invisible) to `1` (opaque); it does not change collision or damage behavior.
- `computing`: maximum occupied non-control functional blocks supported by the craft's single Control Unit.
- `power`: engine thrust power source.
- `max speed`: engine speed cap contribution.
- `power ground`: engine can provide ground propulsion.
- `power air`: engine can provide air propulsion/lift.
- `directional`: whether placement rotation changes the weapon's functional facing; it does not define the firing arc.
- `default direction`: default facing (`up|down|left|right`) before template rotation.
- `has angle limit`: limits weapon aiming around its resolved facing using separate clockwise/counter-clockwise arcs.
- `cw angle`: clockwise limit angle relative to part direction.
- `ccw angle`: anti-clockwise limit angle relative to part direction.
- `projectile class`: one of `bullet|missile|laser`; bullet and missile are physical shots, while laser resolves as instant hitscan.
- `projectile shape`: class-filtered SVG asset (`round|slug|tracer`, `missile|heavy rocket|energy orb`, or `thin|pulse|wide`).
- `projectile size ratio`: uniform `0.1x..10x` scale applied to both the rendered solid projectile and its generated collider.
- `damage`: base hit damage.
- `range`: maximum effective range.
- `cooldown`: base firing cooldown.
- `fire sound`: recorded firing-sample pool selected for this individual weapon part; it is independent of weapon category and combat behavior.
- `recoil`: self-impulse on fire.
- `hit impulse`: impulse applied to hit target.
- `penetration`: armor penetration value.
- `spread angle`: random angular spread.
- `explode on hit`: whether projectile explodes on impact.
- `explode radius`: explosive radius.
- `projectile speed`: flight speed for non-laser projectiles.
- `projectile gravity`: gravity/drop for non-laser projectiles.
- `tracking`: optional seeking available only to missile-class projectiles.
- `tracking turn rate`: homing turn acceleration/rate.
- Firing arcs use only `has angle limit + cw/ccw`; the former `shoot angle` field is not accepted.
- `need loader`: weapon requires loader participation to reload/fire cycle.
- `supported weapon tags`: weapon tags that a loader can service.
- `load multiplier`: loader time multiplier on weapon cooldown.
- `min load time`: minimum enforced loader cycle time.
- `min burst interval`: minimum interval for burst/charge transfer cadence.
- `max capacity`: maximum number of loaded rounds stored directly by a weapon.
- `min fire interval`: minimum seconds between shots released from a weapon whose `max capacity` is not `1`.

Cell-level properties:

- `structure occupy`: occupies structure layer space.
- `functional occupy`: occupies functional layer space.
- `need structure behind`: requires structure support for functional-only cells.
- `take damage`: marks exposed functional geometry as hittable. A hit there is relayed in full, without armor deduction, to the attached structure cell closest to the hit point.
- `attach point`: attachment support marker on functional parts; if multiple attach points exist, all must attach to structure.
- `anchor point`: unique part center reference (mouse placement center).
- `fire point`: unique muzzle/spawn point for weapon projectiles.

#### 4.0.3 Part Type Property Set (By Type)

`structure` should expose:

- `gas cost`, `mass`, `HP`, `tag`, `armor`, `recover`, `color`.

`control` should expose:

- `gas cost`, `mass`, `tag`, `computing`.

`engine` should expose:

- `gas cost`, `mass`, `tag`, `power`, `max speed`, `power ground`, `power air`.

`weapon` should expose:

- `gas cost`, `mass`, `tag`, `projectile class`, `projectile shape`, `projectile size ratio`, `damage`, `range`, `cooldown`, `max capacity`, `min fire interval` (when capacity is not `1`), `fire sound`, `fire sound volume`, `recoil`, `hit impulse`, `penetration`, `spread angle`, `explode on hit`, `explode radius` (when enabled), `projectile speed` and `projectile gravity` (bullet/missile), `tracking` and `tracking turn rate` (missile only), `directional`, `has angle limit`, `cw angle`, `ccw angle`, `need loader`, `default direction`, `computing consumption`.

`loader` should expose:

- `gas cost`, `mass`, `tag`, `supported weapon tags`, `load multiplier`, `min load time`, `min burst interval`.

#### 4.0.4 Default Values (By Type)

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
- `computing`: `1`

`engine` defaults:

- `gas cost`: `10`
- `mass`: `10`
- `tag`: `engine`
- `power`: `200`
- `max speed`: `100`
- `power ground`: `true`
- `power air`: `false`
- Air engines are isotropic and have no direction or angle-limit properties.

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
- `explode radius` (when `explode on hit = true`): `50`
- `projectile speed` (non-laser): `400`
- `fire sound`: defaults to the pool matching the initial weapon behavior and remains independently selectable per part
- `fire sound volume`: `1x` (`0x..2x`; affects only the firing part's muzzle sound and `0x` mutes it)
- `projectile gravity` (non-laser): `100`
- `tracking` (non-laser): `false`
- `tracking turn rate` (tracking only): `50`
- `directional`: `true`
- `has angle limit`: `true`
- `cw angle`: `15`
- `ccw angle`: `15` (`180/180` for omni)
- `need loader`: `false`
- `max capacity`: `2`
- `min fire interval`: `0.2` when `max capacity` is not `1`
- `default direction`: `right`
- `computing consumption`: `1`

`loader` defaults:

- `gas cost`: `10`
- `mass`: `5`
- `tag`: `loader`
- `supported weapon tags`: `cannon`
- `load multiplier`: `1.0`
- `min load time`: `0.5`
- `min burst interval`: `0.2`

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
- Saving geometry persists every currently painted Part Editor block; the `boxes` model and compatibility `cells` mirror are synchronized before the file is written.

Part-level property visibility (left pane):

- Always show:
  - `part name`
  - `part type`
  - `tags`
  - part-type default/common fields (`gas cost`, and other per-type defaults)
- `Category` is catalog-driven and uses the canonical gameplay names rather than technical runtime families:
  - structure: `light steel`, `normal steel`, `heavy steel`;
  - control: `small control unit`, `medium control unit`, `large control unit`;
  - engine: `light tank engine`, `heavy tank engine`, `light aircraft engine`, `heavy aircraft engine`;
  - weapon: `firearm`, `cannon`, `laser`; the cannon category contains explosive and anti-tank variants;
  - loader: `cannons reloader`, `anti-tank gun reloader`.
- Selecting a canonical category opens that existing part; for a new unsaved draft it applies the selected part as a preset while retaining a new identity.
- `structure` selected:
  - Show structure-only fields: `mass`, `HP`, `armor`, `recover`, `color`.
  - Hide engine/weapon/loader-only fields.
- `control` selected:
  - Show: `mass`, `computing`.
- `engine` selected:
  - Show: `mass`, `power`, `max speed`, `power ground`, `power air`.
- `weapon` selected:
  - Replace the category preset selector with `Projectile Class`: `bullet`, `missile`, or `laser`.
  - Filter `Projectile Shape` to the three assets owned by the selected class and expose `Projectile Size Ratio` (`0.1x..10x`).
  - Show `projectile speed` and `projectile gravity` only for Bullet and Missile.
  - Show explosive tuning (`blast radius`, `blast damage`, `falloff`) only when `explode on hit = true`.
  - Show optional `tracking` only for Missile and show `tracking turn rate` only when enabled.
  - Laser hides flight, homing, and explosion controls.
  - Show `has angle limit` and `default direction` for weapon parts.
  - If `has angle limit = true`, show `cw angle` and `ccw angle`.
  - Show `min fire interval` only when `max loaded ammo` is not `1`.
- `loader` selected:
  - Show: `mass`, `supported weapon tags`, `load multiplier`, `min load time`, `min burst interval`.

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
- Control-unit rule:
  - Every craft must contain one and only one Control Unit.
  - Capacity counts occupied functional grid blocks from every engine, weapon, loader, and other non-control functional part; the Control Unit's own footprint is excluded.
  - `small control unit` is `1x1` with capacity `6`; `medium control unit` is `1x2` with capacity `10`; `large control unit` is `2x4` with capacity `20`.
  - A template exceeding its single Control Unit's capacity is invalid and cannot spawn.

### 4.0.6 Canonical Combat Part Set

Weapons:

- `firearm`: omnidirectional with no firing-angle limit, `0.5s` cooldown, `5` damage, `0` penetration, and no blast; intended for `light steel`.
- `cannon` (explosive variant, part name `cannons`): `2s` cooldown, `50` direct damage, `0` penetration, `100` blast radius, `40` blast damage, `1x2` footprint, and requires `cannons reloader`; intended for `normal steel`.
- `cannon` (anti-tank variant, part name `anti-tank gun`): `4s` cooldown, `220` direct damage, `250` penetration, no blast/range damage, `1x2` footprint, and requires `anti-tank gun reloader`; intended for `heavy steel`.
- Both variants share the `cannon` Part Designer category. Their recorded muzzle audio is selected independently through each part's `fireSoundPool`, so category membership does not force identical sounds.
- `laser`: hits across its range without flight time, renders as a short-lived straight beam, has `0.1s` cooldown, `5` damage, `0` penetration, and no blast; intended for `light steel`.

Structure:

- `light steel`: mass `10`, HP `25`, armor `0`, recovery `0/s`.
- `normal steel`: mass `50`, HP `100`, armor `10`, recovery `10/s`.
- `heavy steel`: mass `100`, HP `200`, armor `15`, recovery `20/s`.

Engines:

- `light tank engine`: `1x1`; high-speed ground propulsion for light and medium craft.
- `heavy tank engine`: `2x2`; low speed cap and enough power to move heavy craft.
- `light aircraft engine`: `1x1`; high-speed air propulsion.
- `heavy aircraft engine`: `2x2`; medium-speed air propulsion for larger aircraft.

Canonical craft templates use these exact names and roles:

- `tank`: slow ground craft with `cannons`, `heavy steel`, `heavy tank engine`, `cannons reloader`, and one `medium control unit`.
- `anti-aircraft vehicle`: fast ground craft with `firearm`, `light steel`, `light tank engine`, and one `small control unit`.
- `tank-killer`: medium-speed ground craft with `anti-tank gun`, `normal steel`, `light tank engine`, `anti-tank gun reloader`, and one `small control unit`.
- `fighter aircraft`: fast air craft with `firearm`, `light steel`, `light aircraft engine`, and one `small control unit`.
- `attack aircraft`: medium-speed air craft with `cannons`, `light steel`, `heavy aircraft engine`, `cannons reloader`, and one `medium control unit`.

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

Functional modules have no HP or armor. Their survival is inherited entirely from their supporting structure.

Attachment rules:

- Every functional component must be attached to at least one structure cell.
- Functional components contribute to **mass** and performance only; they have neither HP nor armor.
- Structure overlapped by a functional part receives direct hits normally, including its armor deduction.
- Hits on exposed functional geometry relay all damage to the attached structure cell closest to the hit point and ignore that cell's armor.
- A functional component can attach to multiple structure cells; destruction of any attached cell destroys the whole functional component.
- A ground craft becomes an inoperable wreck when it has no surviving Control Unit, or when it no longer has both a usable ground engine and a fireable weapon. The wreck remains fixed in place and cannot move or fire. On entry, every surviving structure block takes a deterministic-random 1%-50% initial HP loss (never healing a block that was already lower), then its remaining HP decays linearly to zero across 10 seconds. Incoming damage can reduce it faster but never resets or slows the decay. At 10 seconds every surviving block explodes and the craft is removed. An aircraft with no Control Unit instead loses flight control immediately, drops vertically, and is destroyed on ground impact.
- A unit can have one or more Control Units.

### Functional Module Catalog
- Mobility
  - Wheel Drive
  - Track Drive
  - Hover Thruster
  - Jet Engine (air units, omni thrust)
- Power
  - Engine Core (power output)
  - Battery Pack
- Offense
  - Cannon
  - Machine Gun
  - Rocket Pod
  - Bomb Bay (air)
- Control/Support
  - Control Unit (mandatory, at least one per unit)
  - Fire Control Unit (accuracy)
  - Armor Repair Unit
  - Radar/Sensor
  - ECM/Jammer
- Logistics
  - Drone Bay

Design constraints:

- Mass and power budget must be valid.
- Air unit validity rule: at least one engine with `power air = true` is required. Engines with only `power ground = true` do not provide lift/thrust to aircraft.
- Weapon recoil/stability depends on structure and module placement.
- The unit blueprint is invalid without at least one Control Unit.

## 4.3 Display Layer (Visual-Only)

Display layer provides optional visual mesh/sprite styling and silhouette polish.

- Display layer has **zero gameplay authority**:
  - no hitbox contribution
  - no armor contribution
  - no mass contribution
  - no functional contribution
- Physics, collision, damage, and module breakage are evaluated only on Structure + Functional layers.
- Each structure cell is the visible craft body: it uses a shared armor-panel texture with the structure part's color as its default tint. The Craft Designer can save a different tint per cell; placing a structure block onto an occupied cell replaces the prior material and its stats.
- Battle rendering does not add a separate full-tank or full-aircraft silhouette behind the structure grid; the designed blocks define the craft's visible shape.
- Craft paint (`panel`, `stripe`, and `glass`) is a visual-only display layer attached to structure and is always rendered in battle; it does not contribute armor, mass, HP, or simulation collisions.
- Functional parts use their own recognizable icon in the craft palette/editor grid and a component-specific vector glyph on the Phaser battlefield.
- Editor placement rule: display elements are attached to structure cells only, so display visuals stay on/inside structure bounds.

### 4.4 Template Storage

- Default object designs are file-based under `vip/templates/default/`.
- Player-created object designs are stored separately under `vip/templates/user/`.
- On startup, game loads templates from both folders (user templates override same-id defaults).
- Template filenames are derived from sanitized `template.name` (invalid filename characters removed); runtime identity remains integer `id`.
- Template parse/validation/merge rules are shared in `game-core/src/templates/template-schema.ts` so game UI and arena tooling use identical template behavior.
- File-backed template load normalizes placement and loader coverage, and normalized JSON is written back to disk so editor, headless checks, and battle runtime read the same corrected shape.
- Loader auto-injection is part of persisted template normalization; injected loaders are placed on available structure cells to avoid overlapping existing functional footprints and existing attachment anchor cells when possible.
- Detailed template validation severity logic is isolated in `game-core/src/templates/template-validation.ts`.
- Headless smoke includes default-template validation to ensure all system default templates are warning/error free.

### 4.5 Part Storage

- Developer default part definitions are file-based under `vip/parts/default/`.
- Developer/user part overrides are stored under `vip/parts/user/`.
- Canonical default part definitions are explicitly authored in `vip/parts/default/*.json` and are being migrated to the new type-centric schema.
- Default templates reference these explicit part IDs in `partId` so runtime/editor behavior matches configured part semantics.
- Runtime part catalog merge order:
  1. file-backed defaults (`vip/parts/default`),
  2. user part overrides (`vip/parts/user`).
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
- A unit has an available weapon when at least one surviving weapon can fire a loaded round or has a surviving compatible loader that can reload it.
- If every weapon is destroyed, or all loader paths are destroyed and all loaded rounds are exhausted, a ground unit enters its 10-second wreck countdown. An aircraft instead enters irreversible escape mode, returns to its base, and cannot be selected for player control. Aircraft escape movement preserves the craft's current facing for one second, then turns it toward its base and continues retreating.
- Campaign battles and the strategic layer are continuous real time; there is no **Next Round** action or artificial round deadline.
- Battlefield presentation uses two deliberately simple illustrated layers: an air image above the runtime ground boundary and a ground-surface image below it. Hand-painted command-bunker sprites, plated modular craft with restrained blue-player/red-enemy illuminated borders, and faction-tinted SVG projectile assets sit above those layers. Bullet, missile, and laser classes each provide three distinct shapes. Block seams carry a light faction tint, while brighter low-opacity strokes follow only exposed outer structure-cell edges so ownership reads from the designed silhouette without adding a detached floor glow. Friendly and enemy bunkers share a transparent source sprite with side tinting, edge anchoring, and in-world health treatment.
- Tactical overlays are enabled by default outside replay mode: live structure-cell hitboxes, faint faction-colored effective weapon ranges for every craft (with stronger controlled/selected emphasis), movement vectors, and AI aimed-target lines with target reticles. They can still be disabled from Runtime Debug.
- Every live weapon renders its own barrel from the attachment anchor to the simulation muzzle. Barrel direction follows the per-slot clamped world-space aim angle for both AI and manual control, including mirrored left-facing craft; projectiles spawn exactly at that visible barrel tip, while weapon spread affects their outgoing velocity rather than shifting the spawn point.

## 6.2 Ground Battle Space

- 2D battlefield with left-to-right front.
  - Left: player side/base
  - Right: enemy side/base/buildings
- Battle simulation defaults to a logical battlefield size of `2000x1000` (shared by browser runtime and headless/arena runs).
- Test Arena can override battlefield simulation size at runtime; this changes combat space dimensions, not just display scale.
- Battle camera zoom defaults to a vertical fit that keeps the playable span from the air-lane top through the ground-lane bottom visible; Test Arena recalculates that fit from its runtime battlefield height.
- Test Arena zoom only changes display scale (camera/view transform), not simulation dimensions, and can still be adjusted manually after the default vertical fit.
- Ground units move freely on X and Y axes inside the ground combat zone.
- Ground maneuver is continuous positioning (flank, intercept, disengage), not discrete lane switching.
- Unit-vs-unit body overlap is soft-limited: partial overlap is allowed for flow, but deep/full stacking is resolved by runtime separation.

## 6.3 Air Battle Space

- Air units traverse left-right strategic direction on X, and altitude on Z.
- Air objects do not use ground Y axis for hit eligibility.
- On 2D screen, altitude Z is rendered on vertical axis; combat logic treats air layer separately from ground Y matching.
- Air thrust model:
  - Aircraft use only engines with `power air = true` for movement and anti-gravity.
  - Pre-gravity thrust speed is total air-engine power divided by current mass and scaled by the shared air-thrust factor.
  - Effective movement speed is `max(0, preGravityThrustSpeed - gravity)`, capped by the aggregate engine speed cap.
  - Horizontal, vertical, and diagonal commands all use the same speed magnitude; only the normalized direction vector changes. Air-engine power-to-mass uses a shared conversion factor to determine speed/lift capacity, not directional acceleration.
  - If pre-gravity thrust cannot overcome gravity, the aircraft enters a crash state and falls toward the ground.
- Altitude affects:
  - weapon effectiveness
  - bomb accuracy
  - interception risk
  - visibility/sensor lock

### 6.4 Mouse Aiming and Layered Targeting Rules

- Mouse controls player aim target in battle.
- Hold left mouse is the primary fire action; controlled unit keeps firing all manual-controlled weapon slots toward current mouse aim target.
- When a standard controller is connected during a battlefield, the left stick moves the controlled unit and the right stick sets its firing angle. The right trigger or right bumper fires all manual-controlled weapon slots.
- Controller axes use a deadzone and retain the last meaningful right-stick aim while the stick returns to center, allowing the trigger to fire without requiring constant stick deflection.
- Target-dependent manual weapons such as tracking missiles automatically lock the valid enemy closest to the forward aim ray; ordinary projectile weapons continue to use the exact player aim angle without target assistance.
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
- During battle, functional parts use recognizable component-specific glyphs while visual paint remains visibly attached to structure.
- Developer debug tools can enable **Show Part HP Overlay** to visualize per-structure-cell remaining HP with red damage tint and numeric HP text.
- Phaser debug presentation shows live unit/projectile/evading counts, fitted projectile capsules or laser rectangles, velocity vectors, and target lines.
- The dev probe `battle.debug` path exposes compact per-craft position, velocity, structure/functional health counts, AI target and state, dodge state, prediction lead time, aim angle/range, decision path, and fire-block reason.
- Projectile avoidance predicts closest approach, includes craft/projectile radii and projectile gravity, ranks danger using collision clearance plus time-to-impact, and chooses a perpendicular escape vector. Stable per-unit jink phases keep runs reproducible without making stacked crafts move identically.
- Weapon fire, projectile impact, explosion, deployment, and moving-engine sounds are positional relative to the user's current panned/zoomed battlefield view. Fire sound uses alternating recorded variants with class-specific pitch/timbre for rapid-fire, heavy-shot, explosive, tracking, and precision-beam weapons. Heavy cannon combines a cannon recording with a low recoil tail; tracking rockets use a broadband rocket-launch source without an extra synthetic tone. Rapid-fire muzzle sound uses the short broadband bullet-on-metal transients selected by the developer, while rapid-fire and other light-projectile hits use a separate four-variant hard-surface ricochet pool with descending metallic tails. Light ricochets are mixed below heavy impacts so sustained rapid fire remains readable. Heavy impacts use their own pool, with pitch influenced by struck material and loudness driven by damage actually delivered after armor.

---

## 7. Combat and Damage Model (2D Physics-Driven)

No simple fixed hitpoint exchange for whole units. Damage emerges from impacts, penetration, and module failure.

- There is **no object-level HP bar** for units.
- Unit kill state is caused by structural breakup and/or critical functional loss (especially Control Unit failure), not by a single aggregated HP pool.
- Functional parts have no durability pool. Hits on exposed functional geometry are routed to supporting structure, and the part fails as soon as any supporting structure cell fails.
- Broken debris must come from actual destroyed structure/functional parts (no fake-only VFX substitution).
- Ground unit debris stays where it breaks in ground zone; it does not fall to screen bottom.
- Air unit debris falls down with Y-axis gravity until reaching ground zone.

## 7.1 Damage Pipeline

1. Collision/projectile contact resolves against the earliest structure cell or exposed damageable functional box along the asset-fitted projectile sweep. Bullet/Missile SVGs generate one maximized inscribed oriented capsule; Laser SVGs generate a square-ended beam rectangle from their opaque core.
2. Compute local impact energy and contact impulse.
3. Compare vs material resistance.
4. Apply structural damage, crack, or breach on the impacted local structure cell (when a sweep intersects multiple cells in one tick, use the earliest intersection along projectile travel).
5. A functional box overlapping live structure resolves as a normal direct structure hit.
6. An exposed functional hit relays full damage to its closest attached structure cell with no armor deduction.
7. If any attached structure cell is destroyed or detached, the functional module is removed with it.
8. Connectivity rule: any structure cluster disconnected from the craft's alive Control Unit is destroyed immediately.
   - Destroying the Control Unit, the last usable ground engine, or the last fireable weapon makes remaining ground structure a stationary, inoperable wreck. An aircraft that loses control enters an uncontrolled vertical crash and is destroyed when it hits the ground.
9. Armor is applied as flat damage deduction per impacted cell: `damageAfterArmor = incomingDamage - cellArmor`, `effectiveDamage = damageAfterArmor <= 0 ? 1 : damageAfterArmor`.
10. Hit impulse still applies physical response (knockback/vibration) even on low/fully mitigated hits.
11. Projectile penetration controls both continuation and residual direct-hit damage:
   - each shot starts with weapon `penetration`,
   - per-hit cost is `(cellArmor * PENETRATION_ARMOR_SCALER) + cellCurrentHPBeforeDamage`,
   - projectile continues only while `remainingPenetration > 0`,
   - the first cell receives full weapon damage,
   - each later cell receives `baseDamage * (remainingPenetration / initialPenetration)` before its own penetration cost is deducted,
   - a zero-penetration shot still damages its first cell and then stops.
12. A structure cell's visible world-space panel and projectile hitbox use the same canonical size, so hits anywhere on a live displayed cell register consistently.

Damage presentation:

- Structure blocks gain progressively denser code-drawn cracks as their remaining HP falls.
- Blocks below 20% HP emit restrained, low-opacity pixel smoke.
- Every destroyed block emits one short pixel-art burst selected deterministically from three variants; synchronized wreck cleanup uses the same per-block effects without creating a screen-filling blast.

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

Control Unit outcome:

- If all Control Units are destroyed, the unit loses command/control and is treated as mission-killed.

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
- Territory provides its node-specific continuous benefit once captured; garrison upkeep remains a future balancing layer.
- Enemy can counterattack occupied zones.

Strategic tension:

- Expanding too quickly can overextend gas upkeep.
- Defensive depth and logistics become as important as offense.

---

## 10. Economy and Resource Model

Primary global resource: **Gas**

- Strategic income accrues continuously each real-time second and is displayed as a per-minute rate.

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
- Structure/functional/display layer split with always-visible visual-only paint and an optional per-cell part HP debug overlay.
- Multi-weapon units and independent weapon cooldown timers.
- Weapon slot manual-control toggles (default `ON`) and per-slot auto-fire toggles.
- Player-controlled manual slots fire together and runtime-suppress auto fire while keeping the auto toggle state intact.
- Out-of-angle firing is clamped to the nearest allowed weapon-angle boundary, so shots still fire at edge angle.
- Engine modules now provide explicit power; object mobility scales proportionally with total engine power and inversely with current mass.
- Each engine type also defines a max-speed cap. With multiple engines, cap is aggregated by power-weighted average, and real speed is power-to-mass based but never exceeds aggregated max speed.
- Aircraft must have pre-gravity thrust greater than the gravity budget. Otherwise they lose lift, fall, and crash at a random ground-lane Y.
- Aircraft also enter the same direct fall-and-destroy crash path immediately when their Control Unit is lost, even if their engines remain intact.
- Heavy-shot/explosive/tracking weapons now use loader modules and charge-based firing:
  - Loaders process one supported weapon at a time.
  - Player-controlled selected weapon is prioritized for loading.
  - Loader `loadMultiplier` + `fastOperation` modify load time, bounded by `minLoadTime`.
  - A weapon's `max capacity` sets its ready-round limit; loaders only control compatibility and reload timing, with a minimum burst interval floor of `0.5s`.
  - Fire commands sent to a cooling/reloading weapon slot are ignored (no projectile and no recoil/knockback side effects).
- Weapon availability includes future reload capability: a surviving loaded round remains usable after loader loss. Spending the last loaded round without a reload path starts the ground wreck countdown or, for aircraft, escape mode; destroying every weapon triggers the same platform-specific result immediately.
- Part-level functional overrides now drive runtime behavior for all current functional families:
  - weapon parts can override recoil/hit impulse, projectile speed/gravity, explosive blast parameters, tracking turn rate, control-impair tuning, and their own fire-sound volume;
  - loader parts can override supported weapon classes and loader timing parameters;
  - armor `hp` metadata is translated into effective attachment durability scaling.
- Projectile gravity, range-limited lifetime, and debris persistence.
- A ground craft missing control, a usable ground engine, or a fireable weapon now becomes a stationary, damageable 10-second wreck. Its surviving cells take a deterministic-random 1%-50% initial HP loss and then lose remaining HP linearly until they detonate together at zero. Phaser renders that progression with increasing cracks, subtle smoke below 20% HP, and varied per-cell pixel bursts.
- Ground-vehicle-fired non-tracking projectiles now auto-terminate after falling `200` Y-units below their firing Y origin only when the shot was fired above horizontal (`initialVy < 0`); downward-fired shots are excluded.
- Runtime now applies soft same-layer unit separation (ground-ground, air-air) with overlap allowance, inverse-mass push-out, and broad-phase spatial grid lookup to prevent full unit stacking while preserving movement flow.
- AI split into targeting, movement, and shooting modules with a shared composite interface in `game-core/src/ai/composite/`.
- Baseline combat AI now runs through `createCompositeAiController(...)` (target -> movement -> shoot), and the legacy decision-tree entrypoint is kept as a compatibility wrapper.
- Baseline shoot AI now receives per-slot runtime fire inputs from battle runtime (`effectiveRange`, resolved projectile speed/gravity, and world-space firepoint), and no longer assumes a global projectile model.
- Default rapid weapons use quieter per-part muzzle levels (`0.5x` twin cycler, `0.45x` anti-air machine gun); other default weapon parts remain `1x`.
- Weapon fire is progressively muffled with distance from the camera/listener: nearby fire retains its full high-frequency detail, while far and off-screen fire receives stronger high-frequency rolloff in addition to spatial panning and volume attenuation.
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
- Composite shoot decisions may emit one independent fire plan per ready slot, allowing mixed-weapon craft to aim/fire compatible weapons independently while the common command executor still enforces auto-fire, cooldown, angle, and manual-control rules.
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
- Built-in composed choices are the certified `L1` through `L5` ladder. `L1` is the former full high-skill composite. `L2` adds per-weapon capability/impact-cell decisions and acceleration-aware intercepts; `L3` uses weighted target-history regression; `L4` adds defensive base-pressure target ranking; and `L5` uses autoregressive target velocity. The ladder never inspects template IDs/names or part IDs/names: it derives decisions from live range, ballistics, weapon class, damage, penetration, armor, structure, enemy motion, and battlefield position, so newly authored valid craft participate without AI-specific rules.
- `npm --prefix arena run eval:levels -- --minLevel 2 --maxLevel 5 --seeds 16 --threshold 0.6` runs the real `p4-leaderboard` scenario as deterministic, two-game side-swapped series and fails unless every higher adjacent level wins strictly more than 60% of series. The certified results are L2/L1 `10/16`, L3/L2 `11/16`, L4/L3 `10/16`, and L5/L4 `10/16`. Tested L6 prediction variants did not clear the threshold, so L5 is the current ceiling.
- Each dropdown lists built-in module options plus all saved module specs discovered from arena run artifacts (`arena/.arena-data/runs/*/best-composite.json`).
- Grid changes apply immediately (no manual apply step).
- Left-side mode menu includes a dedicated `Leaderboard` screen (new row in the mode grid) that shows ranked composite run scores.
- Leaderboard rating is match-based: each composite run starts at score `100`, then head-to-head results adjust both models using an Elo-style expected-outcome update (larger score gaps produce larger swing factors).
- Leaderboard competition runtime uses `p4-leaderboard` settings from `arena/composite-training.phases.json`: the canonical `2000x1000` battlefield, `400` ground height, four initial units per side, every valid craft in the runtime-merged part/template catalog, fixed zero reinforcement gas, `120s` limit, and `1200` base HP. Each starter group shuffles the filtered catalog and uses distinct craft before repeating, rather than preferring hard-coded IDs. Training and ranking therefore use identical phase-4 conditions.
- One leaderboard round is a side-swapped pair on the same seed. The pair is scored once using ordered base-HP, surviving-structure, operational-unit, and gas-worth margins, preventing a favorable spawn side or deadline tie from being credited as AI strength.
- Elo uses pairwise diminishing-K updates (same two models -> progressively smaller K), which naturally converges under repeated head-to-head loops without hard score caps.
- Leaderboard panel includes quick competition controls: `random pair`, `unranked vs random`, and `manual pair` modes plus configurable run count. Manual-pair rounds cycle the same 16 certification seeds as `eval:levels`.
- Leaderboard model pool contains only the five certified built-ins (`level-1-ai` through `level-5-ai`). Saved training artifacts remain available in AI Selection but are not silently duplicated as built-ins. The persistent version-6 store records Elo, global W/L/T, pair rounds, and per-pair results; the UI auto-loads it and shows each level's saved win rate versus the previous level with a certification mark after 16 rounds above 60%.
- Leaderboard `Run Competition` submits a batched request and executes rounds in parallel across CPU worker threads (all detected cores when worker runtime is available), then refreshes leaderboard/model lists after completion.
- Test Arena module-selection contract is documented in `vip/AI_COMPONENT_CONFIG.md`.
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
- Log output: `vip/.debug/runtime.log`

Recommended startup for debug sessions:

```bash
DEBUG_LOG=1 npm --prefix vip run dev
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

Functional components add mass and capability, but have no independent HP or armor. Their loss effect is triggered when any structure cell supporting that component is destroyed.

Attachment enforcement:

- If any attached structure cell detaches, every functional component linked to it is removed instantly.

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
| Battle Active Cap | 2 + 3 per Delivery Center | Hard friendly logistics limit per battle |
| Unit Call-In Gas Cost | 18 to 65 | By unit tier/mass |
| Refinery Income | 6 gas/minute | Requires a Main Base gas deposit |
| Field Income | 8 to 10/minute | Node-specific resource/oil output while controlled |

Balancing guardrails:

- Average call-in cadence target: one mid unit every 8 to 25 seconds depending on speed and logistics distance.
- If matches snowball too hard, raise garrison upkeep before increasing call-in cost.
