import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const packageDist = path.join(rootDir, "dist");

function normalizeTreePermissions(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    fs.chmodSync(targetPath, 0o755);
    for (const child of fs.readdirSync(targetPath)) {
      normalizeTreePermissions(path.join(targetPath, child));
    }
    return;
  }
  fs.chmodSync(targetPath, 0o644);
}

fs.rmSync(packageDist, { recursive: true, force: true });
fs.mkdirSync(packageDist, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "packages/server/src/index.ts")],
  outfile: path.join(packageDist, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  external: ["cors", "express", "marked", "qrcode", "socket.io"],
  logLevel: "info",
});

fs.cpSync(
  path.join(rootDir, "packages/client/dist"),
  path.join(packageDist, "client"),
  { recursive: true },
);
fs.copyFileSync(
  path.join(rootDir, "data/config.example.json"),
  path.join(packageDist, "config.example.json"),
);

for (const target of ["LICENSE", "README.md", "package.json", "samples", "dist"]) {
  normalizeTreePermissions(path.join(rootDir, target));
}
fs.chmodSync(path.join(rootDir, "bin/mdq.cjs"), 0o755);
