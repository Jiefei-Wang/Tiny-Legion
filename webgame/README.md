# Modular Army 2D (Prototype)

## Run

This prototype is dependency-free and runs directly in browser.

1. Open `webgame/index.html` in a browser.
2. Or serve locally:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080/webgame/`.

## What is implemented

- Base mode with expansion, refinery/lab, and tech unlocks.
- Map mode with node selection and battle launch.
- Battle mode with:
  - Player and AI units (ground + air)
  - Impulse-based knockback and recoil (`deltaV = J / M_total`)
  - Two-layer model (structure cells + attached functional components)
  - Single control unit rule (destroyed control unit mission-kills unit)
  - Cell destruction that removes attached components
  - Gas-based reinforcement deployment and commander-cap limit
- Occupation and garrison flow with gas upkeep.

## Controls

- Click friendly unit to control it.
- `WASD`: move controlled unit.
- `Space`: fire controlled unit.
- Ground units: `W/S` changes lane.
- Air units: `W/S` changes altitude.
