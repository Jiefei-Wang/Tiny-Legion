import type { PartBoxTemplate, PartDefinition } from "../types.ts";

export type PartFootprintCell = {
  x: number;
  y: number;
  occupiesStructureSpace: boolean;
  occupiesFunctionalSpace: boolean;
  needsStructureBehind: boolean;
  isAttachPoint: boolean;
  isShootingPoint: boolean;
  takesDamage: boolean;
  // Legacy alias kept to avoid broad runtime churn.
  takesFunctionalDamage: boolean;
};

export function normalizeRotateQuarter(value: number | undefined): 0 | 1 | 2 | 3 {
  if (!Number.isInteger(value)) {
    return 0;
  }
  const numeric = typeof value === "number" ? value : 0;
  return ((numeric % 4 + 4) % 4) as 0 | 1 | 2 | 3;
}

export function rotateOffsetByQuarter(offsetX: number, offsetY: number, rotateQuarter: 0 | 1 | 2 | 3): { x: number; y: number } {
  if (rotateQuarter === 0) {
    return { x: offsetX, y: offsetY };
  }
  if (rotateQuarter === 1) {
    return { x: -offsetY, y: offsetX };
  }
  if (rotateQuarter === 2) {
    return { x: -offsetX, y: -offsetY };
  }
  return { x: offsetY, y: -offsetX };
}

function normalizePartBoxFlags(box: PartBoxTemplate): {
  occupiesStructureSpace: boolean;
  occupiesFunctionalSpace: boolean;
  needsStructureBehind: boolean;
  isAttachPoint: boolean;
  isShootingPoint: boolean;
  takesDamage: boolean;
  takesFunctionalDamage: boolean;
} {
  let occupiesStructureSpace = box.occupiesStructureSpace === true;
  let occupiesFunctionalSpace = box.occupiesFunctionalSpace !== false;
  const isAttachPoint = box.isAttachPoint === true;
  if (isAttachPoint) {
    occupiesStructureSpace = false;
    occupiesFunctionalSpace = false;
  }
  const needsStructureBehind = box.needsStructureBehind === true && occupiesStructureSpace === false && occupiesFunctionalSpace === true;
  const isShootingPoint = box.isShootingPoint === true;
  const takesDamage = box.takesDamage ?? box.takesFunctionalDamage ?? (occupiesFunctionalSpace || occupiesStructureSpace);
  const takesFunctionalDamage = takesDamage;
  return {
    occupiesStructureSpace,
    occupiesFunctionalSpace,
    needsStructureBehind,
    isAttachPoint,
    isShootingPoint,
    takesDamage,
    takesFunctionalDamage,
  };
}

export function getPartFootprintCells(part: PartDefinition, rotateQuarter: 0 | 1 | 2 | 3): PartFootprintCell[] {
  return part.boxes.map((box) => {
    const localX = box.x - part.anchor.x;
    const localY = box.y - part.anchor.y;
    const rotated = rotateOffsetByQuarter(localX, localY, rotateQuarter);
    const flags = normalizePartBoxFlags(box);
    return {
      x: rotated.x,
      y: rotated.y,
      occupiesStructureSpace: flags.occupiesStructureSpace,
      occupiesFunctionalSpace: flags.occupiesFunctionalSpace,
      needsStructureBehind: flags.needsStructureBehind,
      isAttachPoint: flags.isAttachPoint,
      isShootingPoint: flags.isShootingPoint,
      takesDamage: flags.takesDamage,
      takesFunctionalDamage: flags.takesFunctionalDamage,
    };
  });
}

export function getPartBounds(cells: ReadonlyArray<{ x: number; y: number }>): { minX: number; maxX: number; minY: number; maxY: number } {
  if (cells.length <= 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  let minX = cells[0]?.x ?? 0;
  let maxX = cells[0]?.x ?? 0;
  let minY = cells[0]?.y ?? 0;
  let maxY = cells[0]?.y ?? 0;
  for (const cell of cells) {
    minX = Math.min(minX, cell.x);
    maxX = Math.max(maxX, cell.x);
    minY = Math.min(minY, cell.y);
    maxY = Math.max(maxY, cell.y);
  }
  return { minX, maxX, minY, maxY };
}
