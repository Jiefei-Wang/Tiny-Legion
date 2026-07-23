import { detachCellAttachments } from "./functional-attachments.ts";
import type { StructureCell, UnitInstance } from "../../types.ts";

export function structureIntegrity(unit: UnitInstance): number {
  let alive = 0;
  let total = 0;
  for (const cell of unit.structure) {
    total += 1;
    if (!cell.destroyed) {
      alive += 1;
    }
  }
  return total > 0 ? alive / total : 0;
}

export function aliveStructureCells(structure: StructureCell[]): StructureCell[] {
  return structure.filter((cell) => !cell.destroyed);
}

export function destroyCell(unit: UnitInstance, cellId: number): void {
  const cell = unit.structure.find((entry) => entry.id === cellId);
  if (!cell || cell.destroyed) {
    return;
  }
  cell.destroyed = true;
  cell.strain = cell.breakThreshold;
  detachCellAttachments(unit, cellId);
  destroyDisconnectedFromControl(unit);
  if (unit.structure.every((entry) => entry.destroyed)) {
    unit.alive = false;
  }
}

function destroyDisconnectedFromControl(unit: UnitInstance): void {
  const controlAttachments = unit.attachments.filter((attachment) => attachment.alive && attachment.component === "control");
  if (controlAttachments.length <= 0) {
    unit.vx = 0;
    unit.vy = 0;
    unit.vibrate = 0;
    return;
  }

  const controlCells = controlAttachments
    .map((attachment) => unit.structure.find((cell) => cell.id === attachment.cell && !cell.destroyed) ?? null)
    .filter((cell): cell is StructureCell => cell !== null);
  if (controlCells.length <= 0) {
    unit.vx = 0;
    unit.vy = 0;
    unit.vibrate = 0;
    return;
  }

  const aliveCells = unit.structure.filter((cell) => !cell.destroyed);
  const coordToCell = new Map<string, StructureCell>();
  for (const cell of aliveCells) {
    coordToCell.set(`${cell.x},${cell.y}`, cell);
  }

  const reachableIds = new Set<number>();
  const queue: StructureCell[] = [...controlCells];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || reachableIds.has(current.id)) {
      continue;
    }
    reachableIds.add(current.id);
    const neighbors = [
      coordToCell.get(`${current.x - 1},${current.y}`),
      coordToCell.get(`${current.x + 1},${current.y}`),
      coordToCell.get(`${current.x},${current.y - 1}`),
      coordToCell.get(`${current.x},${current.y + 1}`),
    ];
    for (const neighbor of neighbors) {
      if (neighbor && !reachableIds.has(neighbor.id)) {
        queue.push(neighbor);
      }
    }
  }

  const disconnected = aliveCells.filter((cell) => !reachableIds.has(cell.id));
  if (disconnected.length === 0) {
    return;
  }

  for (const cell of disconnected) {
    cell.destroyed = true;
    cell.strain = cell.breakThreshold;
  }
  for (const cell of disconnected) {
    detachCellAttachments(unit, cell.id);
  }
}
