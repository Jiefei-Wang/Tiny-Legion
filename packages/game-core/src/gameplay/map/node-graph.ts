import type { MapNode } from "../../types.ts";

export function createMapNodes(): MapNode[] {
  return [
    { id: "mine", name: "Frontier Mine", owner: "neutral", garrison: false, reward: 55, defense: 1.0 },
    { id: "pass", name: "Ridge Pass", owner: "enemy", garrison: false, reward: 85, defense: 1.2 },
    { id: "relay", name: "Sky Relay", owner: "enemy", garrison: false, reward: 110, defense: 1.35 },
    { id: "core", name: "Enemy Core Base", owner: "enemy", garrison: false, reward: 180, defense: 1.7 },
  ];
}
