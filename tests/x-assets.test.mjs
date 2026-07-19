import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

describe("X button assets", () => {
  it("keeps the exact official X vector from the brand toolkit", async () => {
    const source = await readFile("assets/reference/x-logo.svg");
    expect(createHash("sha256").update(source).digest("hex"))
      .toBe("dd46f96b6f47fcd33683b79ddfaf3daca1d4f8aeba3c0f2bde1584c69cc699d4");
  });

  it.each([
    ["x.png", 72],
    ["x@2x.png", 144],
    ["x-action.png", 20],
    ["x-action@2x.png", 40]
  ])("renders %s at the required Stream Deck size", async (name, size) => {
    const metadata = await sharp(`com.renehagen.codex-micro.sdPlugin/images/${name}`).metadata();
    expect(metadata).toMatchObject({ format: "png", width: size, height: size });
  });

  it("has no opaque resize gutter beside the X logo", async () => {
    const { data, info } = await sharp("com.renehagen.codex-micro.sdPlugin/images/x@2x.png")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const longestDarkColumn = Array.from({ length: 58 }, (_, offset) => 44 + offset)
      .map((x) => Array.from({ length: 58 }, (_, offset) => 43 + offset)
        .filter((y) => data[(y * info.width + x) * info.channels] < 40).length)
      .reduce((longest, current) => Math.max(longest, current), 0);
    expect(longestDarkColumn).toBeLessThan(20);
  });

  it("matches the gray Fast-key background instead of the lighter microphone surface", async () => {
    const sampleRed = async (name) => {
      const { data, info } = await sharp(`com.renehagen.codex-micro.sdPlugin/images/${name}`)
        .raw()
        .toBuffer({ resolveWithObject: true });
      return data[(72 * info.width + 50) * info.channels];
    };
    const xRed = await sampleRed("x@2x.png");
    const fastRed = await sampleRed("lightning@2x.png");
    const microphoneRed = await sampleRed("microphone@2x.png");
    expect(Math.abs(xRed - fastRed)).toBeLessThan(Math.abs(xRed - microphoneRed));
  });
});
