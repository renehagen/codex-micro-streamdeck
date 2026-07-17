import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "com.renehagen.codex-micro.sdPlugin/bin";
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: ["src/plugin.ts"],
  outfile: `${outdir}/plugin.js`,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: 'import { createRequire as __codexCreateRequire } from "node:module"; const require = __codexCreateRequire(import.meta.url);'
  },
  sourcemap: false,
  minify: false,
  legalComments: "none"
});

await writeFile(`${outdir}/package.json`, '{\n  "type": "module"\n}\n', "utf8");
