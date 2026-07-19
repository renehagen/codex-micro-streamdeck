export const PROFILE_NAME = "Codex Micro";
export const DEVICE_MODEL = "20GAA9902";

export const PROFILE_LAYOUT = {
  "0,0": ["Session status", "com.renehagen.codex-micro.session", 1],
  "1,0": ["Session status", "com.renehagen.codex-micro.session", 1],
  "2,0": ["Session status", "com.renehagen.codex-micro.session", 1],
  "3,0": ["Session status", "com.renehagen.codex-micro.session", 1],
  "4,0": ["Session status", "com.renehagen.codex-micro.session", 1],
  "0,1": ["Effort +", "com.renehagen.codex-micro.effort-up", 1],
  "1,1": ["Fast mode", "com.renehagen.codex-micro.fast-mode", 1],
  "2,1": ["Accept", "com.renehagen.codex-micro.accept", 1],
  "3,1": ["Reject", "com.renehagen.codex-micro.reject", 1],
  "4,1": ["Branch", "com.renehagen.codex-micro.branch", 1],
  "0,2": ["Effort -", "com.renehagen.codex-micro.effort-down", 1],
  "1,2": ["Open X", "com.renehagen.codex-micro.x", 1],
  "2,2": ["Push to talk", "com.renehagen.codex-micro.push-to-talk", 2],
  "4,2": ["Submit to Codex", "com.renehagen.codex-micro.agent", 1]
};

const blankState = () => ({
  FontFamily: "",
  FontSize: 12,
  FontStyle: "",
  FontUnderline: false,
  OutlineThickness: 2,
  ShowTitle: false,
  Title: "",
  TitleAlignment: "bottom",
  TitleColor: "#ffffff"
});

export const createProfileActions = () => Object.fromEntries(
  Object.entries(PROFILE_LAYOUT).map(([coordinate, [name, uuid, stateCount]], index) => [
    coordinate,
    {
      ActionID: `d3c10000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      LinkedTitle: true,
      Name: name,
      Resources: null,
      Settings: {},
      State: 0,
      States: Array.from({ length: stateCount }, blankState),
      UUID: uuid
    }
  ])
);
