#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const packageRoot = path.resolve(__dirname, "..");
const launchDir = process.cwd();
const dataDir = path.resolve(launchDir, process.env.MDQ_DATA_DIR || "data");
const command = process.argv[2];

function printHelp() {
  console.log(`MDQ Core

Usage:
  mdq              Initialise missing runtime folders, then start MDQ
  mdq init         Initialise runtime folders and public samples only
  mdq --help       Show this help
  mdq --version    Show the installed version

Runtime data:
  Defaults to ./data in the directory where mdq is launched.
  Set MDQ_DATA_DIR to use a different directory.
`);
}

function copyIfMissing(source, destination) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function initialiseRuntime() {
  for (const directory of [
    "decks",
    "images",
    "videos",
    "sessions",
    "submissions",
    "winners",
    "access",
  ]) {
    fs.mkdirSync(path.join(dataDir, directory), { recursive: true });
  }

  const sampleDecksDir = path.join(packageRoot, "samples", "decks");
  if (fs.existsSync(sampleDecksDir)) {
    for (const filename of fs.readdirSync(sampleDecksDir)) {
      if (filename.endsWith(".md")) {
        copyIfMissing(
          path.join(sampleDecksDir, filename),
          path.join(dataDir, "decks", filename),
        );
      }
    }
  }

  const sampleImagesDir = path.join(packageRoot, "samples", "images");
  if (fs.existsSync(sampleImagesDir)) {
    for (const filename of fs.readdirSync(sampleImagesDir)) {
      const source = path.join(sampleImagesDir, filename);
      if (fs.statSync(source).isFile()) {
        copyIfMissing(source, path.join(dataDir, "images", filename));
      }
    }
  }

  copyIfMissing(
    path.join(packageRoot, "dist", "config.example.json"),
    path.join(dataDir, "config.example.json"),
  );
}

if (command === "--help" || command === "-h" || command === "help") {
  printHelp();
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(require(path.join(packageRoot, "package.json")).version);
  process.exit(0);
}

if (command && command !== "init") {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

initialiseRuntime();
console.log(`MDQ data directory: ${dataDir}`);

if (command === "init") {
  console.log("MDQ runtime directory is ready.");
  process.exit(0);
}

process.env.MDQ_DATA_DIR = dataDir;
process.env.MDQ_CLIENT_DIST = path.join(packageRoot, "dist", "client");
require(path.join(packageRoot, "dist", "server.cjs"));
