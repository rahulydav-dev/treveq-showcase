// Shared with the hub_settings reader so the two cannot drift apart.
export const DEFAULT_CARS_PER_WASHER = 20;

export interface ZoneCapacityInput {
  // Active subscribed cars whose location falls inside the zone's cells.
  carCount: number;
  carsPerWasherTarget: number;
  // Null means the CEO has not planned this zone yet.
  targetWashers: number | null;
  activeWashers: number;
  approvedNotActive: number;
  // Submitted applications for this zone that are still fresh; stale ones stop
  // holding a slot so an unreviewed application cannot silently block hiring.
  freshSubmittedApplications: number;
}

export interface ZoneCapacity {
  cars: number;
  suggestion: number;
  target: number | null;
  committed: number;
  vacancy: number;
  shortfall: number;
  surplus: number;
}

// Capacity is advisory: the suggestion is shown next to the real numbers and
// the CEO sets the target.
export function zoneCapacity(i: ZoneCapacityInput): ZoneCapacity {
  const perWasher = i.carsPerWasherTarget > 0 ? i.carsPerWasherTarget : DEFAULT_CARS_PER_WASHER;
  const suggestion = Math.ceil(i.carCount / perWasher);
  const committed = i.activeWashers + i.approvedNotActive + i.freshSubmittedApplications;
  const target = i.targetWashers;

  return {
    cars: i.carCount,
    suggestion,
    target,
    committed,
    vacancy: Math.max(0, (target ?? 0) - committed),
    shortfall: Math.max(0, suggestion - i.activeWashers),
    // The null check here is deliberate, not an oversight to be tidied into
    // `target ?? 0`: a target of 0 means "planned for nobody", so staff in it
    // are genuine surplus, whereas null means unplanned and we make no claim.
    surplus: target === null ? 0 : Math.max(0, i.activeWashers - target),
  };
}
