export interface OneBotTarget {
  type: "group" | "user";
  id: number;
}

export type GroupToolTargetPolicy = "force-current-group" | "respect-target";

export function resolveToolTargetByPolicy(
  requestedTarget: OneBotTarget | null,
  currentTarget: OneBotTarget | null,
  policy: GroupToolTargetPolicy,
): OneBotTarget | null {
  if (policy === "force-current-group" && currentTarget?.type === "group") {
    return currentTarget;
  }
  return requestedTarget;
}
