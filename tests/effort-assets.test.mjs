import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

const referenceHashes = {
  "assets/reference/effort-down.jpeg": "72faf96630b65bd9362f4e160d6ee7d590871ff2d770012c7bdbaa0aad5bfa8c",
  "assets/reference/effort-up.jpeg": "ec1c7bdad8877c912fe2b88838e618a8bc7ebf48369931f202cba232d11f8ca3"
};

describe("Effort button assets", () => {
  it("keeps the exact supplied source images", async () => {
    for (const [path, expected] of Object.entries(referenceHashes)) {
      const digest = createHash("sha256").update(await readFile(path)).digest("hex");
      expect(digest).toBe(expected);
    }
  });

  it.each([
    ["effort-up.png", 72],
    ["effort-up@2x.png", 144],
    ["effort-down.png", 72],
    ["effort-down@2x.png", 144]
  ])("renders %s as a high-quality square RGB key", async (name, size) => {
    const metadata = await sharp(`com.renehagen.codex-micro.sdPlugin/images/${name}`).metadata();
    expect(metadata).toMatchObject({ format: "png", width: size, height: size, channels: 3, space: "srgb" });
  });

  it.each([
    "effort-up@2x.png",
    "effort-down@2x.png"
  ])("retains the complete physical keycap while tightly cropping %s", async (name) => {
    const { data, info } = await sharp(`com.renehagen.codex-micro.sdPlugin/images/${name}`)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const redAt = (x, y) => data[(y * info.width + x) * info.channels];
    expect(redAt(Math.floor(info.width / 2), 0)).toBeGreaterThan(235);
    expect(redAt(info.width - 1, Math.floor(info.height / 2))).toBeLessThan(180);
    expect(redAt(Math.floor(info.width / 2), info.height - 1)).toBeLessThan(180);
  });

  it.each([
    ["effort-up-action.png", 20],
    ["effort-up-action@2x.png", 40],
    ["effort-down-action.png", 20],
    ["effort-down-action@2x.png", 40]
  ])("renders %s with transparency", async (name, size) => {
    const metadata = await sharp(`com.renehagen.codex-micro.sdPlugin/images/${name}`).metadata();
    expect(metadata).toMatchObject({ format: "png", width: size, height: size, channels: 4, hasAlpha: true });
  });
});
