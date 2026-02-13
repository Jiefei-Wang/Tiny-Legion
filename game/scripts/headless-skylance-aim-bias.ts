import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { PROJECTILE_GRAVITY, PROJECTILE_SPEED } from "../src/config/balance/range.ts";
import { COMPONENTS } from "../src/config/balance/weapons.ts";
import { mergePartCatalogs, parsePartDefinition } from "../src/app/part-store.ts";
import { mergeTemplates, parseTemplate } from "../src/app/template-store.ts";
import { solveBallisticAim } from "../src/ai/shooting/ballistic-aim.ts";
import { createInitialTemplates, instantiateUnit } from "../src/simulation/units/unit-builder.ts";
import type { PartDefinition, UnitTemplate } from "../src/types.ts";

declare const process: { exit: (code?: number) => void; cwd: () => string };

function readPartDir(dirPath: string): PartDefinition[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
  const parts: PartDefinition[] = [];
  for (const fileName of files) {
    try {
      const filePath = `${dirPath}/${fileName}`;
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const normalized = parsePartDefinition(parsed);
      if (!normalized) {
        continue;
      }
      const normalizedRaw = `${JSON.stringify(normalized, null, 2)}\n`;
      if (raw !== normalizedRaw) {
        writeFileSync(filePath, normalizedRaw, "utf8");
      }
      parts.push(normalized);
    } catch {
      continue;
    }
  }
  return parts;
}

function loadRuntimeMergedParts(): PartDefinition[] {
  const root = process.cwd().replace(/\\/g, "/");
  const defaults = readPartDir(`${root}/parts/default`);
  const users = readPartDir(`${root}/parts/user`);
  return mergePartCatalogs(defaults, users);
}

function serializeTemplateForFile(template: UnitTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    type: template.type,
    structure: template.structure.map((cell) => ({ partId: cell.partId, x: cell.x, y: cell.y })),
    attachments: template.attachments.map((attachment) => ({
      component: attachment.component,
      partId: attachment.partId,
      cell: attachment.cell,
      x: attachment.x,
      y: attachment.y,
      rotateQuarter: attachment.rotateQuarter,
      rotate90: attachment.rotate90,
    })),
    display: template.display?.map((item) => ({ kind: item.kind, cell: item.cell, x: item.x, y: item.y })) ?? [],
  };
}

function readTemplateDir(dirPath: string, partCatalog: ReadonlyArray<PartDefinition>): UnitTemplate[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
  const templates: UnitTemplate[] = [];
  for (const fileName of files) {
    try {
      const filePath = `${dirPath}/${fileName}`;
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const normalized = parseTemplate(parsed, { injectLoaders: true, sanitizePlacement: true, partCatalog });
      if (!normalized) {
        continue;
      }
      const normalizedRaw = `${JSON.stringify(serializeTemplateForFile(normalized), null, 2)}\n`;
      if (raw !== normalizedRaw) {
        writeFileSync(filePath, normalizedRaw, "utf8");
      }
      templates.push(normalized);
    } catch {
      continue;
    }
  }
  return templates;
}

function loadRuntimeMergedTemplates(partCatalog: ReadonlyArray<PartDefinition>): UnitTemplate[] {
  const baseTemplates = createInitialTemplates();
  const root = process.cwd().replace(/\\/g, "/");
  const defaults = readTemplateDir(`${root}/templates/default`, partCatalog);
  const users = readTemplateDir(`${root}/templates/user`, partCatalog);
  return mergeTemplates(baseTemplates, mergeTemplates(defaults, users));
}

function solveBallisticAimWith(
  shooterX: number,
  shooterY: number,
  targetX: number,
  targetY: number,
  targetVx: number,
  targetVy: number,
  maxRange: number,
  projectileSpeed: number,
  projectileGravity: number,
): { firingAngleRad: number; leadTimeS: number } | null {
  const MIN_T = 0.08;
  const MAX_T = Math.min(2.0, Math.max(0.14, Math.min(2.0, (maxRange / projectileSpeed) * 1.12)));
  if (MAX_T <= MIN_T) {
    return null;
  }

  const speedErrorAtTime = (t: number): number => {
    const px = targetX + targetVx * t;
    const py = targetY + targetVy * t;
    const dx = px - shooterX;
    const dy = py - shooterY;
    const vx = dx / t;
    const vy = (dy - 0.5 * projectileGravity * t * t) / t;
    return vx * vx + vy * vy - projectileSpeed * projectileSpeed;
  };

  let t0 = MIN_T;
  let f0 = speedErrorAtTime(t0);
  const steps = 28;
  let bracket: { a: number; b: number; fa: number } | null = null;
  for (let i = 1; i <= steps; i += 1) {
    const t1 = MIN_T + ((MAX_T - MIN_T) * i) / steps;
    const f1 = speedErrorAtTime(t1);
    if ((f0 > 0 && f1 <= 0) || (f0 <= 0 && f1 > 0)) {
      bracket = { a: t0, b: t1, fa: f0 };
      break;
    }
    t0 = t1;
    f0 = f1;
  }
  if (!bracket) {
    return null;
  }

  let a = bracket.a;
  let b = bracket.b;
  let fa = bracket.fa;
  for (let i = 0; i < 26; i += 1) {
    const m = (a + b) * 0.5;
    const fm = speedErrorAtTime(m);
    if (Math.abs(fm) < 1e-3) {
      a = m;
      b = m;
      break;
    }
    if ((fa > 0 && fm <= 0) || (fa <= 0 && fm > 0)) {
      b = m;
    } else {
      a = m;
      fa = fm;
    }
  }

  const t = (a + b) * 0.5;
  const vx = (targetX + targetVx * t - shooterX) / Math.max(0.001, t);
  const vy = (targetY + targetVy * t - shooterY - 0.5 * projectileGravity * t * t) / Math.max(0.001, t);
  return {
    firingAngleRad: Math.atan2(vy, vx),
    leadTimeS: t,
  };
}

function simulateClosestDy(
  shooterX: number,
  shooterY: number,
  targetX: number,
  targetY: number,
  angleRad: number,
  projectileSpeed: number,
  projectileGravity: number,
): { closestDy: number; closestDistance: number } {
  const dt = 1 / 60;
  let x = shooterX;
  let y = shooterY;
  let vx = Math.cos(angleRad) * projectileSpeed;
  let vy = Math.sin(angleRad) * projectileSpeed;
  let closestDistance = Number.POSITIVE_INFINITY;
  let closestDy = 0;

  for (let i = 0; i < 180; i += 1) {
    vy += projectileGravity * dt;
    x += vx * dt;
    y += vy * dt;
    const dx = x - targetX;
    const dy = y - targetY;
    const dist = Math.hypot(dx, dy);
    if (dist < closestDistance) {
      closestDistance = dist;
      closestDy = dy;
    }
  }

  return { closestDy, closestDistance };
}

function main(): void {
  const partCatalog = loadRuntimeMergedParts();
  const templates = loadRuntimeMergedTemplates(partCatalog);
  const skylanceTemplate = templates.find((template) => template.id === 5);
  if (!skylanceTemplate) {
    throw new Error("Skylance (id=5) not found");
  }

  const shooter = instantiateUnit(templates, skylanceTemplate.id, "player", 400, 300, { partCatalog });
  if (!shooter) {
    throw new Error("Failed to instantiate Skylance shooter");
  }
  const weaponAttachmentId = shooter.weaponAttachmentIds[0];
  const weaponAttachment = shooter.attachments.find((a) => a.id === weaponAttachmentId && a.alive);
  if (!weaponAttachment) {
    throw new Error("Skylance has no alive weapon attachment");
  }
  const componentStats = COMPONENTS[weaponAttachment.component];
  if (componentStats.type !== "weapon" || componentStats.range === undefined || componentStats.projectileSpeed === undefined) {
    throw new Error("Skylance weapon stats unavailable");
  }
  const effectiveRange = weaponAttachment.stats?.range ?? componentStats.range;
  const weaponSpeed = weaponAttachment.stats?.projectileSpeed ?? componentStats.projectileSpeed;
  const weaponGravity = weaponAttachment.stats?.projectileGravity ?? componentStats.projectileGravity ?? PROJECTILE_GRAVITY;

  const targetX = shooter.x + 280;
  const targetY = shooter.y;

  const globalSolution = solveBallisticAim(
    shooter.x,
    shooter.y,
    targetX,
    targetY,
    0,
    0,
    effectiveRange,
  );
  if (!globalSolution) {
    throw new Error("Global solver returned null");
  }
  const weaponSolution = solveBallisticAimWith(
    shooter.x,
    shooter.y,
    targetX,
    targetY,
    0,
    0,
    effectiveRange,
    weaponSpeed,
    weaponGravity,
  );
  if (!weaponSolution) {
    throw new Error("Weapon-specific solver returned null");
  }

  const missWithGlobalAngle = simulateClosestDy(
    shooter.x,
    shooter.y,
    targetX,
    targetY,
    globalSolution.firingAngleRad,
    weaponSpeed,
    weaponGravity,
  );
  const missWithWeaponAngle = simulateClosestDy(
    shooter.x,
    shooter.y,
    targetX,
    targetY,
    weaponSolution.firingAngleRad,
    weaponSpeed,
    weaponGravity,
  );

  console.log("[headless-skylance-aim-bias]");
  console.log(`skylance weapon speed=${weaponSpeed.toFixed(2)} gravity=${weaponGravity.toFixed(2)} range=${effectiveRange.toFixed(2)}`);
  console.log(`solver constants speed=${PROJECTILE_SPEED.toFixed(2)} gravity=${PROJECTILE_GRAVITY.toFixed(2)}`);
  console.log(`global-solver angleDeg=${(globalSolution.firingAngleRad * 180 / Math.PI).toFixed(3)} lead=${globalSolution.leadTimeS.toFixed(3)}s`);
  console.log(`weapon-solver angleDeg=${(weaponSolution.firingAngleRad * 180 / Math.PI).toFixed(3)} lead=${weaponSolution.leadTimeS.toFixed(3)}s`);
  console.log(`miss(global angle with real weapon physics): closestDy=${missWithGlobalAngle.closestDy.toFixed(3)} closestDist=${missWithGlobalAngle.closestDistance.toFixed(3)}`);
  console.log(`miss(weapon angle with real weapon physics): closestDy=${missWithWeaponAngle.closestDy.toFixed(3)} closestDist=${missWithWeaponAngle.closestDistance.toFixed(3)}`);
  console.log("dy sign note: negative means projectile was above target at closest approach.");
}

main();
