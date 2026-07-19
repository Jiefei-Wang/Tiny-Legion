import type { MapNode, TechState } from "../../types.ts";

export type BaseSlotSize = "small" | "medium";
export type BuildingKind = "refinery" | "research-lab" | "workshop" | "delivery-center";
export type ResearchKind = keyof Pick<TechState, "reinforced" | "combined" | "mediumWeapons">;

export interface BaseBuildingSlot {
  id: "small-a" | "small-b" | "medium-a" | "medium-b";
  size: BaseSlotSize;
  building: BuildingKind | null;
}

export interface CampaignTimedJob {
  id: number;
  type: "building" | "research";
  target: BuildingKind | ResearchKind;
  slotId?: BaseBuildingSlot["id"];
  durationSeconds: number;
  remainingSeconds: number;
}

export interface LogisticsQuote {
  sourceNodeId: "home" | string;
  sourceName: string;
  distance: number;
  travelSeconds: number;
  gasCostMultiplier: number;
  freeFromOutpost: boolean;
}

export const BUILDING_CATALOG: Record<BuildingKind, {
  name: string;
  size: BaseSlotSize;
  gasCost: number;
  buildSeconds: number;
  description: string;
}> = {
  refinery: { name: "Gas Refinery", size: "small", gasCost: 90, buildSeconds: 35, description: "Processes local gas deposits into continuous income." },
  "research-lab": { name: "Research Lab", size: "small", gasCost: 110, buildSeconds: 50, description: "Runs timed material and weapon research." },
  workshop: { name: "Workshop", size: "medium", gasCost: 100, buildSeconds: 45, description: "Maintains and fabricates selected craft designs." },
  "delivery-center": { name: "Delivery Center", size: "medium", gasCost: 140, buildSeconds: 60, description: "Raises the number of friendly units supported in one battle." },
};

export const RESEARCH_CATALOG: Record<ResearchKind, { name: string; gasCost: number; durationSeconds: number }> = {
  reinforced: { name: "Reinforced structures", gasCost: 130, durationSeconds: 55 },
  combined: { name: "Combined composite", gasCost: 180, durationSeconds: 85 },
  mediumWeapons: { name: "Explosive cannon", gasCost: 170, durationSeconds: 75 },
};

export class RealTimeCampaign {
  public readonly slots: BaseBuildingSlot[] = [
    { id: "small-a", size: "small", building: "refinery" },
    { id: "small-b", size: "small", building: null },
    { id: "medium-a", size: "medium", building: "workshop" },
    { id: "medium-b", size: "medium", building: null },
  ];
  public readonly jobs: CampaignTimedJob[] = [];
  public elapsedSeconds = 0;
  private nextJobId = 1;
  private incomeRemainder = 0;

  public getBuildingCount(kind: BuildingKind): number {
    return this.slots.filter((slot) => slot.building === kind).length;
  }

  public getDeliveryCapacity(): number {
    return 2 + this.getBuildingCount("delivery-center") * 3;
  }

  public queueBuilding(kind: BuildingKind, slotId: BaseBuildingSlot["id"], hasGasDeposit: boolean): { ok: boolean; reason?: string; cost?: number } {
    const definition = BUILDING_CATALOG[kind];
    const slot = this.slots.find((entry) => entry.id === slotId);
    if (!slot) return { ok: false, reason: "Unknown building spot." };
    if (slot.size !== definition.size) return { ok: false, reason: `${definition.name} requires a ${definition.size} spot.` };
    if (slot.building || this.jobs.some((job) => job.slotId === slot.id)) return { ok: false, reason: "That building spot is occupied." };
    if (kind === "refinery" && !hasGasDeposit) return { ok: false, reason: "A refinery requires a gas deposit at the main base." };
    this.jobs.push({ id: this.nextJobId++, type: "building", target: kind, slotId, durationSeconds: definition.buildSeconds, remainingSeconds: definition.buildSeconds });
    return { ok: true, cost: definition.gasCost };
  }

  public queueResearch(kind: ResearchKind): { ok: boolean; reason?: string; cost?: number } {
    if (this.getBuildingCount("research-lab") < 1) return { ok: false, reason: "An operational Research Lab is required." };
    if (this.jobs.some((job) => job.type === "research" && job.target === kind)) return { ok: false, reason: "That research is already running." };
    const definition = RESEARCH_CATALOG[kind];
    this.jobs.push({ id: this.nextJobId++, type: "research", target: kind, durationSeconds: definition.durationSeconds, remainingSeconds: definition.durationSeconds });
    return { ok: true, cost: definition.gasCost };
  }

  public update(dt: number, nodes: ReadonlyArray<MapNode>): { gasIncome: number; completed: CampaignTimedJob[] } {
    const safeDt = Math.max(0, Math.min(1, dt));
    this.elapsedSeconds += safeDt;
    const refineryIncome = this.getBuildingCount("refinery") * 6;
    const territoryIncome = nodes.filter((node) => node.owner === "player").reduce((sum, node) => sum + (node.gasYieldPerMinute ?? node.resourceYieldPerMinute ?? 0), 0);
    this.incomeRemainder += ((refineryIncome + territoryIncome) / 60) * safeDt;
    const gasIncome = Math.floor(this.incomeRemainder);
    this.incomeRemainder -= gasIncome;

    for (const job of this.jobs) job.remainingSeconds = Math.max(0, job.remainingSeconds - safeDt);
    const completed = this.jobs.filter((job) => job.remainingSeconds <= 0);
    for (const job of completed) {
      if (job.type === "building" && job.slotId) {
        const slot = this.slots.find((entry) => entry.id === job.slotId);
        if (slot) slot.building = job.target as BuildingKind;
      }
    }
    for (const job of completed) this.jobs.splice(this.jobs.indexOf(job), 1);
    return { gasIncome, completed };
  }
}

export function getNearestLogisticsSource(nodes: ReadonlyArray<MapNode>, battlefieldNodeId: string): { id: "home" | string; name: string; distance: number } {
  const target = nodes.find((node) => node.id === battlefieldNodeId);
  const targetDistance = Math.max(0, target?.distanceFromHome ?? 20);
  let best: { id: "home" | string; name: string; distance: number } = { id: "home", name: "Main Base", distance: targetDistance };
  for (const node of nodes) {
    if (node.kind !== "remote-base" || node.owner !== "player") continue;
    const distance = Math.abs(targetDistance - Math.max(0, node.distanceFromHome ?? 0));
    if (distance < best.distance) best = { id: node.id, name: node.name, distance };
  }
  return best;
}

export function quoteBattleLogistics(nodes: ReadonlyArray<MapNode>, battlefieldNodeId: string, unitSpeed: number, templateId?: number): LogisticsQuote {
  const source = getNearestLogisticsSource(nodes, battlefieldNodeId);
  const target = nodes.find((node) => node.id === battlefieldNodeId);
  const targetDistance = Math.max(0, target?.distanceFromHome ?? 20);
  const supportingOutpost = nodes.find((node) => node.kind === "outpost" && node.owner === "player"
    && (node.outpostTemplateIds ?? []).includes(templateId ?? -1)
    && Math.abs(targetDistance - Math.max(0, node.distanceFromHome ?? 0)) <= (node.outpostRange ?? 0));
  const freeFromOutpost = Boolean(supportingOutpost);
  const distance = freeFromOutpost ? 0 : source.distance;
  const travelSeconds = freeFromOutpost ? 3 : Math.max(4, (distance * 70) / Math.max(20, unitSpeed));
  return {
    sourceNodeId: supportingOutpost?.id ?? source.id,
    sourceName: supportingOutpost?.name ?? source.name,
    distance,
    travelSeconds,
    gasCostMultiplier: freeFromOutpost ? 0 : 1 + Math.min(0.6, distance / 180),
    freeFromOutpost,
  };
}
