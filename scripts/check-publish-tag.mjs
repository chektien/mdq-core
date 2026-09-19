import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(scriptDir, "..", "package.json"), "utf8"),
);
const tag = process.env.npm_config_tag || "latest";
const isPrerelease = packageJson.version.includes("-");

if (isPrerelease && tag === "latest") {
  throw new Error(
    `Refusing to publish prerelease ${packageJson.version} under npm's latest tag. `
      + "Use npm run release:npm to publish it under beta.",
  );
}

console.log(`npm publish tag verified: ${tag}`);
