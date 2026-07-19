import { describe, expect, it } from "vitest";
import sharp from "sharp";

describe("Finder button assets", () => {
  it.each([
    ["finder.png", 72],
    ["finder@2x.png", 144],
    ["finder-action.png", 20],
    ["finder-action@2x.png", 40]
  ])("renders %s at the required Stream Deck size", async (name, size) => {
    const metadata = await sharp(`com.renehagen.codex-micro.sdPlugin/images/${name}`).metadata();
    expect(metadata).toMatchObject({ format: "png", width: size, height: size });
  });

  it("uses a visibly full-colour palette", async () => {
    const { data, info } = await sharp("com.renehagen.codex-micro.sdPlugin/images/finder@2x.png")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let colourfulPixels = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      if (Math.max(red, green, blue) - Math.min(red, green, blue) > 35) colourfulPixels += 1;
    }
    expect(colourfulPixels).toBeGreaterThan(info.width * info.height * .45);
  });
});
