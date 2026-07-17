import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const source = "assets/reference/codex-micro-official.webp";
const output = "com.renehagen.codex-micro.sdPlugin/images";
await mkdir(output, { recursive: true });

const effortSources = {
  up: {
    source: "assets/reference/effort-up.jpeg",
    crop: { left: 235, top: 219, width: 784, height: 784 },
    glyphCrop: { left: 483, top: 459, width: 288, height: 288 }
  },
  down: {
    source: "assets/reference/effort-down.jpeg",
    crop: { left: 239, top: 222, width: 777, height: 777 },
    glyphCrop: { left: 483, top: 459, width: 288, height: 288 }
  }
};

const crops = {
  session: { left: 589, top: 525, width: 160, height: 161 },
  lightning: { left: 424, top: 684, width: 160, height: 161 },
  accept: { left: 589, top: 684, width: 160, height: 161 },
  reject: { left: 753, top: 684, width: 160, height: 161 },
  branch: { left: 918, top: 684, width: 160, height: 161 },
  microphone: { left: 733, top: 897, width: 34, height: 43 },
  agent: { left: 918, top: 844, width: 160, height: 160 }
};

const glyphCrops = {
  lightning: { left: 476, top: 732, width: 56, height: 64 },
  accept: { left: 641, top: 736, width: 56, height: 56 },
  reject: { left: 805, top: 736, width: 56, height: 56 },
  branch: { left: 970, top: 736, width: 56, height: 56 },
  microphone: crops.microphone,
  agent: { left: 968, top: 894, width: 60, height: 60 }
};

async function writeRasterPair(name, crop, transform) {
  for (const [size, suffix] of [[72, ""], [144, "@2x"]]) {
    let image = sharp(source).extract(crop).resize(size, size, { fit: "fill" });
    if (transform) image = await transform(image, size);
    await image.png({ compressionLevel: 9 }).toFile(`${output}/${name}${suffix}.png`);
  }
}

async function writeEffortPair(name, direction) {
  const config = effortSources[direction];
  for (const [size, suffix] of [[72, ""], [144, "@2x"]]) {
    await sharp(config.source)
      .extract(config.crop)
      .resize(size, size, { kernel: sharp.kernel.lanczos3 })
      .toColourspace("srgb")
      .png({ compressionLevel: 9 })
      .toFile(`${output}/${name}${suffix}.png`);
  }
}

async function writeActionSvgPair(name, factory) {
  for (const [size, suffix] of [[20, ""], [40, "@2x"]]) {
    await sharp(factory(size)).png({ compressionLevel: 9 }).toFile(`${output}/${name}${suffix}.png`);
  }
}

async function writeWhiteGlyphPair(name, crop, sizes) {
  for (const [size, suffix] of sizes) {
    const padding = Math.max(2, Math.round(size * .12));
    const inner = size - padding * 2;
    const alpha = await sharp(source)
      .extract(crop)
      .resize(inner, inner, { fit: "contain", background: "#ffffff" })
      .grayscale()
      .negate()
      .threshold(88)
      .raw()
      .toBuffer();
    const white = Buffer.alloc(inner * inner * 3, 255);
    const glyph = await sharp(white, { raw: { width: inner, height: inner, channels: 3 } })
      .joinChannel(alpha, { raw: { width: inner, height: inner, channels: 1 } })
      .png()
      .toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: glyph, left: padding, top: padding }])
      .png({ compressionLevel: 9 })
      .toFile(`${output}/${name}${suffix}.png`);
  }
}

async function writeGlyphActionPair(name, crop) {
  return writeWhiteGlyphPair(`${name}-action`, crop, [[20, ""], [40, "@2x"]]);
}

function sessionActionSvg(size) {
  const dots = [0, 1, 2, 3, 4].map((index) =>
    `<circle cx="${size * (.18 + index * .16)}" cy="${size * .5}" r="${size * .07}" ${index === 0 ? 'fill="#fff"' : 'fill="none" stroke="#fff" stroke-width="1.5"'}/>`
  ).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${dots}</svg>`);
}

async function writeEffortActionPair(name, direction) {
  const config = effortSources[direction];
  for (const [size, suffix] of [[20, ""], [40, "@2x"]]) {
    const padding = Math.max(1, Math.round(size * .08));
    const inner = size - padding * 2;
    const alpha = await sharp(config.source)
      .extract(config.glyphCrop)
      .resize(inner, inner, { fit: "contain", kernel: sharp.kernel.lanczos3 })
      .grayscale()
      .negate()
      .threshold(88)
      .raw()
      .toBuffer();
    const white = Buffer.alloc(inner * inner * 3, 255);
    const glyph = await sharp(white, { raw: { width: inner, height: inner, channels: 3 } })
      .joinChannel(alpha, { raw: { width: inner, height: inner, channels: 1 } })
      .png()
      .toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: glyph, left: padding, top: padding }])
      .png({ compressionLevel: 9 })
      .toFile(`${output}/${name}${suffix}.png`);
  }
}

async function microphoneGlyph(size) {
  const width = Math.round(size * .235);
  const height = Math.round(size * .295);
  const alpha = await sharp(source)
    .extract(crops.microphone)
    .resize(width, height)
    .grayscale()
    .negate()
    .threshold(90)
    .raw()
    .toBuffer();
  const black = Buffer.alloc(width * height * 3, 15);
  return sharp(black, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

async function writeMicrophonePair() {
  for (const [size, suffix] of [[72, ""], [144, "@2x"]]) {
    const glyph = await microphoneGlyph(size);
    const glyphWidth = Math.round(size * .235);
    const glyphHeight = Math.round(size * .295);
    const cover = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs><radialGradient id="b"><stop offset="0" stop-color="#edf0f1"/><stop offset="1" stop-color="#e5e9eb"/></radialGradient></defs>
      <circle cx="${size / 2}" cy="${size * .49}" r="${size * .215}" fill="url(#b)"/>
    </svg>`);
    const base = await sharp(source).extract(crops.lightning).resize(size, size, { fit: "fill" })
      .composite([
        { input: cover },
        { input: glyph, left: Math.round((size - glyphWidth) / 2), top: Math.round(size * .49 - glyphHeight / 2) }
      ])
      .png()
      .toBuffer();
    await sharp(base).png({ compressionLevel: 9 }).toFile(`${output}/microphone${suffix}.png`);

    const border = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect x="${size * .04}" y="${size * .04}" width="${size * .92}" height="${size * .92}" rx="${size * .13}" fill="none" stroke="#9CD5FE" stroke-width="${size * .055}"/>
    </svg>`);
    await sharp(base).modulate({ brightness: 1.05, saturation: 1.08 }).composite([{ input: border }])
      .png({ compressionLevel: 9 }).toFile(`${output}/microphone-active${suffix}.png`);
  }
}

await Promise.all([
  writeRasterPair("session-idle", crops.session),
  writeRasterPair("lightning", crops.lightning),
  writeRasterPair("accept", crops.accept),
  writeRasterPair("reject", crops.reject),
  writeRasterPair("branch", crops.branch),
  writeRasterPair("agent", crops.agent),
  writeEffortPair("effort-up", "up"),
  writeEffortPair("effort-down", "down")
]);
await writeMicrophonePair();

await Promise.all([
  writeActionSvgPair("session-action", sessionActionSvg),
  writeEffortActionPair("effort-up-action", "up"),
  writeEffortActionPair("effort-down-action", "down"),
  ...Object.entries(glyphCrops).map(([name, crop]) => writeGlyphActionPair(name, crop)),
  writeWhiteGlyphPair("category", glyphCrops.agent, [[28, ""], [56, "@2x"]])
]);

for (const [size, suffix] of [[256, ""], [512, "@2x"]]) {
  await sharp(source).extract(crops.agent).resize(size, size).png({ compressionLevel: 9 }).toFile(`${output}/plugin${suffix}.png`);
}
