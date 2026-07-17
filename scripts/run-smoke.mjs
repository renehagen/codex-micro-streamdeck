import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temporary = await mkdtemp(path.join(tmpdir(), "codex-micro-smoke-"));
const outfile = path.join(temporary, "smoke.mjs");

try {
  await build({
    entryPoints: ["scripts/smoke-bridge.ts"],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: false,
    legalComments: "none"
  });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
