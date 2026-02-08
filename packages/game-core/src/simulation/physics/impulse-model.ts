export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function impulseToDeltaV(impulse: number, mass: number): number {
  return impulse / Math.max(1, mass);
}
