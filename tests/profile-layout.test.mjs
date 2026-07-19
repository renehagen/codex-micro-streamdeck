import { describe, expect, it } from "vitest";
import { createProfileActions, PROFILE_LAYOUT } from "../scripts/profile-layout.mjs";

describe("Codex Micro profile layout", () => {
  it("contains the 14 configured actions", () => {
    expect(Object.keys(PROFILE_LAYOUT)).toHaveLength(14);
    expect(Object.keys(PROFILE_LAYOUT).sort()).toEqual([
      "0,0", "0,1", "0,2", "1,0", "1,1", "1,2", "2,0", "2,1", "2,2",
      "3,0", "3,1", "4,0", "4,1", "4,2"
    ]);
  });

  it("puts X between effort minus and the lower-center microphone", () => {
    const actions = createProfileActions();
    expect(actions["1,2"].UUID).toBe("com.renehagen.codex-micro.x");
    expect(actions["1,2"].Name).toBe("Open X");
    expect(actions["2,2"].UUID).toBe("com.renehagen.codex-micro.push-to-talk");
    expect(actions["4,2"].UUID).toBe("com.renehagen.codex-micro.agent");
    expect(actions["3,2"]).toBeUndefined();
  });

  it("keeps effort plus and minus as the first keys of rows two and three", () => {
    const actions = createProfileActions();
    expect(actions["0,1"].UUID).toBe("com.renehagen.codex-micro.effort-up");
    expect(actions["0,1"].Name).toBe("Effort +");
    expect(actions["0,2"].UUID).toBe("com.renehagen.codex-micro.effort-down");
    expect(actions["0,2"].Name).toBe("Effort -");
  });

  it("uses two visual states only for push-to-talk", () => {
    const actions = createProfileActions();
    expect(actions["2,2"].States).toHaveLength(2);
    expect(Object.values(actions).filter((action) => action.States.length === 2)).toHaveLength(1);
  });
});
