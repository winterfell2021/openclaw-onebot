import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveToolTargetByPolicy, type OneBotTarget } from "../src/target-policy";

describe("resolveToolTargetByPolicy", () => {
  it("force-current-group 时应强制使用当前群", () => {
    const requested: OneBotTarget = { type: "group", id: 365674704 };
    const current: OneBotTarget = { type: "group", id: 615223376 };
    const effective = resolveToolTargetByPolicy(requested, current, "force-current-group");
    assert.deepEqual(effective, current);
  });

  it("respect-target 时应保留请求 target", () => {
    const requested: OneBotTarget = { type: "group", id: 365674704 };
    const current: OneBotTarget = { type: "group", id: 615223376 };
    const effective = resolveToolTargetByPolicy(requested, current, "respect-target");
    assert.deepEqual(effective, requested);
  });

  it("当前上下文不是群聊时不强制改写", () => {
    const requested: OneBotTarget = { type: "group", id: 615223376 };
    const current: OneBotTarget = { type: "user", id: 365674704 };
    const effective = resolveToolTargetByPolicy(requested, current, "force-current-group");
    assert.deepEqual(effective, requested);
  });
});
