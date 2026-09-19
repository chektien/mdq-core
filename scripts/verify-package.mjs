import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-package-"));
const packDir = path.join(tempDir, "pack");
const installDir = path.join(tempDir, "install");
const runtimeDir = path.join(tempDir, "runtime-data");
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(installDir, { recursive: true });

const cleanNpmEnv = { ...process.env };
delete cleanNpmEnv.npm_config_dry_run;
delete cleanNpmEnv.NPM_CONFIG_DRY_RUN;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
    env: cleanNpmEnv,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout || ""}${result.stderr || ""}`,
    );
  }
  return result;
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Installed MDQ exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // The child may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for the installed MDQ health endpoint");
}

try {
  const packResult = run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDir,
  ]);
  const [manifest] = JSON.parse(packResult.stdout);
  const packedFiles = manifest.files.map((entry) => entry.path);

  const forbiddenPrefixes = [
    "backups/",
    "data/",
    "packages/",
    ".git/",
    ".openclaw-run/",
  ];
  const forbidden = packedFiles.filter((filename) =>
    forbiddenPrefixes.some((prefix) => filename.startsWith(prefix)),
  );
  assert.deepEqual(forbidden, [], `Private or source files were packed: ${forbidden.join(", ")}`);
  assert(packedFiles.includes("dist/server.cjs"), "Pack is missing the server bundle");
  assert(packedFiles.includes("dist/client/index.html"), "Pack is missing the client build");
  assert(packedFiles.includes("samples/decks/week00.md"), "Pack is missing public samples");
  assert(packedFiles.includes("bin/mdq.cjs"), "Pack is missing the CLI");
  const unreadable = manifest.files.filter((entry) => (entry.mode & 0o444) === 0);
  assert.deepEqual(unreadable, [], "Pack contains files without read permission");
  const cliEntry = manifest.files.find((entry) => entry.path === "bin/mdq.cjs");
  assert(cliEntry && (cliEntry.mode & 0o111) !== 0, "Packed CLI is not executable");

  const tarball = path.join(packDir, manifest.filename);
  run("npm", ["init", "--yes"], { cwd: installDir });
  run("npm", ["install", "--ignore-scripts", tarball], { cwd: installDir });

  const cli = path.join(installDir, "node_modules", ".bin", "mdq");
  run(cli, ["init"], {
    cwd: installDir,
    env: { ...process.env, MDQ_DATA_DIR: runtimeDir },
  });
  assert(fs.existsSync(path.join(runtimeDir, "decks", "week00.md")));
  assert(fs.existsSync(path.join(runtimeDir, "config.example.json")));

  const port = await reservePort();
  const child = spawn(cli, [], {
    cwd: installDir,
    env: {
      ...process.env,
      MDQ_DATA_DIR: runtimeDir,
      MDQ_BIND_HOST: "127.0.0.1",
      MDQ_DISABLE_TAILSCALE: "1",
      PORT: String(port),
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(port, child);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200, "Installed package did not serve the client");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }

  console.log(`Verified mdq-core package: ${packedFiles.length} files, ${manifest.size} bytes`);
  console.log("Verified clean install, isolated runtime data, health endpoint, and client assets");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
