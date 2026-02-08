import type { MaterialId, MaterialStats } from "../../types.ts";

export const MATERIALS: Record<MaterialId, MaterialStats> = {
  basic: { label: "Basic Steel", mass: 10, armor: 1.0, hp: 110, recoverPerSecond: 2.2, color: "#95a4b8" },
  reinforced: { label: "Reinforced", mass: 13, armor: 1.3, hp: 150, recoverPerSecond: 1.9, color: "#8ca3bd" },
  ceramic: { label: "Ceramic", mass: 9, armor: 1.2, hp: 120, recoverPerSecond: 2.0, color: "#a8d1e6" },
  reactive: { label: "Reactive", mass: 14, armor: 1.55, hp: 170, recoverPerSecond: 1.7, color: "#d0bb90" },
  combined: { label: "Combined Mk1", mass: 12, armor: 1.5, hp: 165, recoverPerSecond: 1.8, color: "#bda9d8" },
};
