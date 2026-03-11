import { AsyncLocalStorage } from "async_hooks";
import { parseOneBotTarget, getRuntimeOptions } from "../config";
import { resolveToolTargetByPolicy } from "../target-policy";
import type { OneBotTarget } from "../target-policy";
import type { OneBotToolExecutionContext } from "../types";
import type { OneBotRuntimeOptions } from "../options";

export const oneBotToolContextStorage = new AsyncLocalStorage<OneBotToolExecutionContext>();

export function getCurrentToolExecutionContext(): OneBotToolExecutionContext | undefined {
  return oneBotToolContextStorage.getStore();
}

export function resolveEffectiveToolTarget(
  rawTarget: string,
  runtimeOptions: OneBotRuntimeOptions,
  logger?: { warn?: (msg: string) => void },
): OneBotTarget | null {
  const requested = parseOneBotTarget(rawTarget);
  const contextTarget = getCurrentToolExecutionContext()?.target ?? null;
  const effective = resolveToolTargetByPolicy(
    requested,
    contextTarget,
    runtimeOptions.groupToolTargetPolicy,
  );
  if (
    runtimeOptions.groupToolTargetPolicy === "force-current-group" &&
    contextTarget?.type === "group" &&
    requested &&
    (requested.type !== contextTarget.type || requested.id !== contextTarget.id)
  ) {
    logger?.warn?.(
      `[onebot] force current group target: requested=${requested.type}:${requested.id}, effective=group:${contextTarget.id}`,
    );
  }
  return effective;
}
