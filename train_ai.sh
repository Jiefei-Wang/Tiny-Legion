#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARENA_PREFIX="npm --prefix ${ROOT_DIR}/arena run train:composite --"

command="${1:-help}"
if [[ $# -gt 0 ]]; then
  shift
fi

scope="all"
seed_composite=""
phase_seeds="16"
generations="20"
population="24"
parallel="8"
max_sim_seconds="240"
node_defense="1"
base_hp="1200"
player_gas="10000"
enemy_gas="10000"
spawn_burst="1"
spawn_max_active="5"
n_units="4"
quiet="false"

target_source="baseline"
movement_source="baseline"
shoot_source="baseline"

target_layers=""
target_hidden=""
movement_layers=""
movement_hidden=""
shoot_layers=""
shoot_hidden=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) scope="$2"; shift 2 ;;
    --seed-composite) seed_composite="$2"; shift 2 ;;
    --phase-seeds) phase_seeds="$2"; shift 2 ;;
    --generations) generations="$2"; shift 2 ;;
    --population) population="$2"; shift 2 ;;
    --parallel) parallel="$2"; shift 2 ;;
    --max-sim-seconds) max_sim_seconds="$2"; shift 2 ;;
    --node-defense) node_defense="$2"; shift 2 ;;
    --base-hp) base_hp="$2"; shift 2 ;;
    --player-gas) player_gas="$2"; shift 2 ;;
    --enemy-gas) enemy_gas="$2"; shift 2 ;;
    --spawn-burst) spawn_burst="$2"; shift 2 ;;
    --spawn-max-active) spawn_max_active="$2"; shift 2 ;;
    --n-units) n_units="$2"; shift 2 ;;
    --quiet) quiet="true"; shift 1 ;;

    --target-source) target_source="$2"; shift 2 ;;
    --movement-source) movement_source="$2"; shift 2 ;;
    --shoot-source) shoot_source="$2"; shift 2 ;;

    --target-layers) target_layers="$2"; shift 2 ;;
    --target-hidden) target_hidden="$2"; shift 2 ;;
    --movement-layers) movement_layers="$2"; shift 2 ;;
    --movement-hidden) movement_hidden="$2"; shift 2 ;;
    --shoot-layers) shoot_layers="$2"; shift 2 ;;
    --shoot-hidden) shoot_hidden="$2"; shift 2 ;;

    --layers)
      if [[ "$command" == "shoot" ]]; then shoot_layers="$2"; fi
      if [[ "$command" == "movement" ]]; then movement_layers="$2"; fi
      if [[ "$command" == "target" ]]; then target_layers="$2"; fi
      shift 2
      ;;
    --hidden)
      if [[ "$command" == "shoot" ]]; then shoot_hidden="$2"; fi
      if [[ "$command" == "movement" ]]; then movement_hidden="$2"; fi
      if [[ "$command" == "target" ]]; then target_hidden="$2"; fi
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ "$command" == "help" ]]; then
  echo "train_ai.sh commands"
  echo "  compose                     Train shoot -> movement -> target"
  echo "  shoot                       Train shoot module only"
  echo "  movement                    Train movement module only"
  echo "  target                      Train target module only"
  echo ""
  echo "Common options"
  echo "  --seed-composite <path>     Start from trained composite JSON"
  echo "  --target-source <source>    baseline | new | trained:<path>"
  echo "  --movement-source <source>  baseline | new | trained:<path>"
  echo "  --shoot-source <source>     baseline | new | trained:<path>"
  echo "  --target-layers <n> --target-hidden <n>"
  echo "  --movement-layers <n> --movement-hidden <n>"
  echo "  --shoot-layers <n> --shoot-hidden <n>"
  echo "  --phase-seeds <n> --generations <n> --population <n> --parallel <n> --n-units <n>"
  echo ""
  echo "Examples"
  echo "  ./train_ai.sh shoot --shoot-source new --target-source baseline --movement-source baseline --layers 2 --hidden 16"
  echo "  ./train_ai.sh movement --movement-source new --target-source baseline --shoot-source trained:arena/.arena-data/runs/<run-id>/shoot/p3-battlefield-base/best-module.json --layers 2 --hidden 20"
  echo "  ./train_ai.sh compose --target-source new --movement-source new --shoot-source new --target-layers 2 --target-hidden 14 --movement-layers 2 --movement-hidden 18 --shoot-layers 2 --shoot-hidden 16"
  exit 0
fi

if [[ "$command" == "shoot" ]]; then scope="shoot"; fi
if [[ "$command" == "movement" ]]; then scope="movement"; fi
if [[ "$command" == "target" ]]; then scope="target"; fi
if [[ "$command" == "compose" ]]; then scope="all"; fi
if [[ "$command" != "shoot" && "$command" != "movement" && "$command" != "target" && "$command" != "compose" ]]; then
  echo "Unknown command: $command"
  exit 1
fi

cmd=(npm --prefix "${ROOT_DIR}/arena" run train:composite -- --scope "$scope" --phaseSeeds "$phase_seeds" --generations "$generations" --population "$population" --parallel "$parallel" --maxSimSeconds "$max_sim_seconds" --nodeDefense "$node_defense" --baseHp "$base_hp" --playerGas "$player_gas" --enemyGas "$enemy_gas" --spawnBurst "$spawn_burst" --spawnMaxActive "$spawn_max_active" --nUnits "$n_units" --targetSource "$target_source" --movementSource "$movement_source" --shootSource "$shoot_source")

if [[ -n "$seed_composite" ]]; then cmd+=(--seedComposite "$seed_composite"); fi
if [[ -n "$target_layers" ]]; then cmd+=(--targetLayers "$target_layers"); fi
if [[ -n "$target_hidden" ]]; then cmd+=(--targetHidden "$target_hidden"); fi
if [[ -n "$movement_layers" ]]; then cmd+=(--movementLayers "$movement_layers"); fi
if [[ -n "$movement_hidden" ]]; then cmd+=(--movementHidden "$movement_hidden"); fi
if [[ -n "$shoot_layers" ]]; then cmd+=(--shootLayers "$shoot_layers"); fi
if [[ -n "$shoot_hidden" ]]; then cmd+=(--shootHidden "$shoot_hidden"); fi
if [[ "$quiet" == "true" ]]; then cmd+=(--quiet true); fi

printf 'Running:'
printf ' %q' "${cmd[@]}"
printf '\n'
"${cmd[@]}"
