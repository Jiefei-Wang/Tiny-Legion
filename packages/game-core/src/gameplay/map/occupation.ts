import type { MapNode } from "../../types.ts";

export function setNodeOwner(nodes: MapNode[], nodeId: string, owner: MapNode["owner"]): void {
  const node = nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    return;
  }
  node.owner = owner;
}

export function settleGarrison(nodes: MapNode[], nodeId: string): boolean {
  const node = nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    return false;
  }
  node.garrison = true;
  return true;
}
