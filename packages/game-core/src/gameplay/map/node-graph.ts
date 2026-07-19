import type { MapNode } from "../../types.ts";

export function createMapNodes(): MapNode[] {
  return [
    { id: "mine", name: "Ironwood Fields", kind: "resource", owner: "neutral", garrison: false, reward: 55, defense: 1.0, x: 35, y: 25, links: ["pass", "quarry"], distanceFromHome: 18, resourceYieldPerMinute: 8 },
    { id: "oil", name: "Blackglass Oilfield", kind: "oil", owner: "enemy", garrison: false, reward: 70, defense: 1.12, x: 61, y: 58, links: ["quarry", "delta-base"], distanceFromHome: 24, gasDeposit: true, gasYieldPerMinute: 10 },
    { id: "pass", name: "Ridge Pass", kind: "battlefield", owner: "enemy", garrison: false, reward: 85, defense: 1.2, x: 52, y: 30, links: ["mine", "relay"], distanceFromHome: 34 },
    { id: "quarry", name: "Shale Crossing", kind: "battlefield", owner: "neutral", garrison: false, reward: 60, defense: 1.08, x: 43, y: 48, links: ["mine", "oil", "relay", "delta-base"], distanceFromHome: 38 },
    { id: "delta-base", name: "Delta Relay Base", kind: "remote-base", owner: "enemy", garrison: false, reward: 100, defense: 1.35, x: 39, y: 73, links: ["oil", "quarry", "outpost"], distanceFromHome: 52 },
    { id: "relay", name: "Sky Relay", kind: "outpost", owner: "enemy", garrison: false, reward: 110, defense: 1.35, x: 72, y: 27, links: ["pass", "quarry", "outpost"], distanceFromHome: 58, outpostTemplateIds: [1], outpostRange: 30 },
    { id: "outpost", name: "Kestrel Outpost", kind: "outpost", owner: "enemy", garrison: false, reward: 125, defense: 1.5, x: 79, y: 61, links: ["relay", "delta-base", "core"], distanceFromHome: 72, outpostTemplateIds: [1, 3], outpostRange: 26 },
    { id: "core", name: "Enemy Core Base", kind: "enemy-base", owner: "enemy", garrison: false, reward: 180, defense: 1.7, x: 91, y: 38, links: ["outpost"], distanceFromHome: 92, gasDeposit: true },
  ];
}
