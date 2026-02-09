Original prompt: for user controlled unit, default to control all weapons together. If user press a num key, toggle the control of the correponding weapon.shitf+num still togger auto fire. With the default to be true. However, if user is controlling a weapon, the auto fire will be temporarily disabled (still shows true and enabled when user do not control the weapon)

## TODO
- Add per-slot manual control toggles (default all true) for player-controlled weapons.
- Change `1..9` input from slot selection to control toggle.
- Keep `Shift+1..9` as auto-fire toggle.
- Make manual fire trigger all controlled slots.
- Suppress auto-fire runtime for slots that are manually controlled, without changing displayed auto-fire state.
- Update weapon HUD/help text.
- Update gameplay/architecture docs.
- Run verification (`test:headless`, plus web-game skill checks if available).

## Progress
- Added `weaponManualControl: boolean[]` to `UnitInstance` and defaulted all weapon slots to `true` in unit construction.
- Added `toggleControlledWeaponManualControl()` in battle session and switched number-key semantics to per-slot manual-control toggling.
- Updated manual fire to fire all slots with manual control enabled.
- Added runtime-only auto-fire suppression for slots with manual control enabled, while keeping `weaponAutoFire` unchanged.
- Updated battle controls text + weapon HUD chips to show `CTRL/FREE` alongside `AUTO/MANUAL`.
- Synced docs in `AGENTS.md`, `GAME_PLAN.md`, and `SOFTWARE_ARCHITECTURE.md`.
- Fixed cooldown/reload no-op behavior per weapon slot: if a slot is not ready, `fireWeaponSlot` now returns before recoil, so failed fire commands do not apply backward impulse.
- Verified with `npm --prefix game run test:headless` (PASS).
- Refactored editor navigation to top-level mode tabs: `Template Editor` and `Part Editor` now sit alongside `Battle` in the left mode strip.
- Removed nested editor workspace switch buttons; `Debug Options -> Part Designer` now routes directly to the `Part Editor` tab.
- Updated left upper mode-strip UI: removed the `Mode` heading and changed tab layout to a 2x3 grid.
- Synced docs for new editor/tab structure in `GAME_PLAN.md` and `SOFTWARE_ARCHITECTURE.md`.
- Re-ran `npm --prefix game run test:headless` (PASS) after tab/UI changes.
- Attempted Playwright visual verification via `$WEB_GAME_CLIENT`, but environment is missing the `playwright` package (`ERR_MODULE_NOT_FOUND`).
- Added a dedicated `Test Arena` tab (separate from `Battle`) with controls for enemy count, spawning specific enemies, and toggling controlled-unit invincibility.
