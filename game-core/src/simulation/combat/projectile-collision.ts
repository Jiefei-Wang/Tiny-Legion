const clampNumber = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Exact continuous entry time for a circle swept along a segment against an axis-aligned box. */
export function segmentRoundedAabbEntryTime(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
): number | null {
  const pointDistanceSquared = (x: number, y: number): number => {
    const cx = clampNumber(x, left, right);
    const cy = clampNumber(y, top, bottom);
    return (x - cx) ** 2 + (y - cy) ** 2;
  };
  if (pointDistanceSquared(x0, y0) <= radius * radius) return 0;
  const candidates: number[] = [];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const addAtX = (x: number): void => {
    if (Math.abs(dx) < 1e-9) return;
    const t = (x - x0) / dx;
    const y = y0 + dy * t;
    if (t >= 0 && t <= 1 && y >= top && y <= bottom) candidates.push(t);
  };
  const addAtY = (y: number): void => {
    if (Math.abs(dy) < 1e-9) return;
    const t = (y - y0) / dy;
    const x = x0 + dx * t;
    if (t >= 0 && t <= 1 && x >= left && x <= right) candidates.push(t);
  };
  addAtX(left - radius);
  addAtX(right + radius);
  addAtY(top - radius);
  addAtY(bottom + radius);
  const a = dx * dx + dy * dy;
  if (a > 1e-9) {
    for (const corner of [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]) {
      const ox = x0 - corner.x;
      const oy = y0 - corner.y;
      const b = 2 * (ox * dx + oy * dy);
      const c = ox * ox + oy * oy - radius * radius;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) continue;
      const root = Math.sqrt(discriminant);
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (t >= 0 && t <= 1) candidates.push(t);
      }
    }
  }
  candidates.sort((aValue, bValue) => aValue - bValue);
  for (const t of candidates) {
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    if (pointDistanceSquared(x, y) <= radius * radius + 1e-6) return t;
  }
  return null;
}

/** SAT intersection/entry estimate for a square-ended beam rectangle against an axis-aligned box. */
export function orientedBeamAabbEntryTime(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  halfWidth: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-6) return null;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  const along = corners.map((point) => (point.x - x0) * ux + (point.y - y0) * uy);
  const across = corners.map((point) => (point.x - x0) * px + (point.y - y0) * py);
  const alongMin = Math.min(...along);
  const alongMax = Math.max(...along);
  const acrossMin = Math.min(...across);
  const acrossMax = Math.max(...across);
  if (alongMax < 0 || alongMin > length || acrossMax < -halfWidth || acrossMin > halfWidth) return null;
  const beamCorners = [
    { x: x0 + px * halfWidth, y: y0 + py * halfWidth },
    { x: x0 - px * halfWidth, y: y0 - py * halfWidth },
    { x: x1 + px * halfWidth, y: y1 + py * halfWidth },
    { x: x1 - px * halfWidth, y: y1 - py * halfWidth },
  ];
  if (
    Math.max(...beamCorners.map((point) => point.x)) < left
    || Math.min(...beamCorners.map((point) => point.x)) > right
    || Math.max(...beamCorners.map((point) => point.y)) < top
    || Math.min(...beamCorners.map((point) => point.y)) > bottom
  ) return null;
  return clampNumber(Math.max(0, alongMin) / length, 0, 1);
}
