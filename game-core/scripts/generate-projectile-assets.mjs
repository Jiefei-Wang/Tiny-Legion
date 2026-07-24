import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import sharp from "sharp";

export const projectileAssetDir = resolve("game-core", "assets", "projectiles");
export const generatedProjectileAssetPath = resolve(
  "game-core", "src", "projectiles", "generated", "projectile-assets.generated.ts",
);

const EXPECTED = {
  "bullet-round": "bullet",
  "bullet-slug": "bullet",
  "bullet-tracer": "bullet",
  "missile-missile": "missile",
  "missile-heavy-rocket": "missile",
  "missile-energy-orb": "missile",
  "laser-thin": "laser",
  "laser-pulse": "laser",
  "laser-wide": "laser",
};
const RASTER_WIDTH = 512;
const ALPHA_SOLID = Math.ceil(255 * 0.95);

function squaredDistanceToBoundary(x, y, boundary) {
  let best = Number.POSITIVE_INFINITY;
  for (const point of boundary) {
    const dx = x - point.x;
    const dy = y - point.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return best;
}

function fitCapsule(mask, width, height) {
  const boundary = [];
  const solidAt = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!solidAt(x, y)) continue;
      if (!solidAt(x - 1, y) || !solidAt(x + 1, y) || !solidAt(x, y - 1) || !solidAt(x, y + 1)) {
        boundary.push({ x, y });
      }
    }
  }
  if (boundary.length === 0) throw new Error("asset has no opaque solid boundary");

  const distances = new Float32Array(width * height);
  let maxRadius = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!solidAt(x, y)) continue;
      const distance = Math.sqrt(squaredDistanceToBoundary(x, y, boundary)) + 0.5;
      distances[y * width + x] = distance;
      maxRadius = Math.max(maxRadius, Math.floor(distance));
    }
  }

  let best = null;
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let y = 0; y < height; y += 1) {
      let runStart = -1;
      for (let x = 0; x <= width; x += 1) {
        const eligible = x < width && distances[y * width + x] >= radius;
        if (eligible && runStart < 0) runStart = x;
        if ((!eligible || x === width) && runStart >= 0) {
          const runEnd = x - 1;
          const halfLength = Math.max(0, (runEnd - runStart) / 2);
          const area = Math.PI * radius * radius + 4 * radius * halfLength;
          if (!best || area > best.area) {
            best = {
              area,
              centerX: (runStart + runEnd) / 2,
              centerY: y,
              halfLength,
              radius,
            };
          }
          runStart = -1;
        }
      }
    }
  }
  if (!best) throw new Error("asset has no capsule-compatible solid body");
  return best;
}

function fitLaser(mask, width, height) {
  let best = null;
  for (let top = 0; top < height; top += 1) {
    for (let bottom = top; bottom < height; bottom += 1) {
      let validColumns = 0;
      for (let x = 0; x < width; x += 1) {
        let solid = true;
        for (let y = top; y <= bottom; y += 1) {
          if (mask[y * width + x] !== 1) {
            solid = false;
            break;
          }
        }
        if (solid) validColumns += 1;
      }
      if (validColumns >= width * 0.95 && (!best || bottom - top > best.bottom - best.top)) {
        best = { top, bottom };
      }
    }
  }
  if (!best) throw new Error("laser asset has no continuous opaque core");
  return { centerY: (best.top + best.bottom) / 2, halfHeight: (best.bottom - best.top + 1) / 2 };
}

async function readAsset(stem, projectileClass) {
  const filePath = resolve(projectileAssetDir, `${stem}.svg`);
  if (!existsSync(filePath)) throw new Error(`missing projectile asset ${filePath}`);
  const svg = readFileSync(filePath);
  const metadata = await sharp(svg).metadata();
  const aspect = (metadata.width ?? 1) / Math.max(1, metadata.height ?? 1);
  const rasterHeight = Math.max(32, Math.round(RASTER_WIDTH / aspect));
  const { data, info } = await sharp(svg)
    .resize(RASTER_WIDTH, rasterHeight, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * info.channels + 3] >= ALPHA_SOLID ? 1 : 0;
  const normalizeX = (value) => Number((value / info.width).toFixed(6));
  const normalizeY = (value) => Number((value / info.height).toFixed(6));
  const collider = projectileClass === "laser"
    ? (() => {
        const fit = fitLaser(mask, info.width, info.height);
        return { kind: "beam-rect", centerY: normalizeY(fit.centerY), halfHeight: normalizeY(fit.halfHeight) };
      })()
    : (() => {
        const fit = fitCapsule(mask, info.width, info.height);
        return {
          kind: "capsule",
          centerX: normalizeX(fit.centerX),
          centerY: normalizeY(fit.centerY),
          halfLength: normalizeX(fit.halfLength),
          radius: normalizeY(fit.radius),
        };
      })();
  return {
    projectileClass,
    url: `/assets/projectiles/${stem}.svg`,
    aspect: Number(aspect.toFixed(6)),
    collider,
  };
}

export async function generateProjectileAssets({ check = false } = {}) {
  const actual = readdirSync(projectileAssetDir)
    .filter((name) => name.endsWith(".svg"))
    .map((name) => name.slice(0, -4))
    .sort();
  const expected = Object.keys(EXPECTED).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`projectile SVG set mismatch; expected ${expected.join(", ")}, received ${actual.join(", ")}`);
  }
  const entries = {};
  for (const [stem, projectileClass] of Object.entries(EXPECTED)) entries[stem] = await readAsset(stem, projectileClass);
  const source = `/* AUTO-GENERATED by game-core/scripts/generate-projectile-assets.mjs. */\n`
    + `import type { ProjectileAssetDefinition, ProjectileShape } from "../../types.ts";\n\n`
    + `export const PROJECTILE_ASSETS = ${JSON.stringify(entries, null, 2)} as const satisfies Record<ProjectileShape, ProjectileAssetDefinition>;\n`;
  if (check) {
    if (!existsSync(generatedProjectileAssetPath) || readFileSync(generatedProjectileAssetPath, "utf8") !== source) {
      throw new Error("generated projectile asset manifest is out of date; run npm run projectiles:generate");
    }
  } else {
    mkdirSync(dirname(generatedProjectileAssetPath), { recursive: true });
    writeFileSync(generatedProjectileAssetPath, source, "utf8");
  }
  return entries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateProjectileAssets({ check: process.argv.includes("--check") }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
