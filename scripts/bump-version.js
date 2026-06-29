import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const packagePath = join(process.cwd(), "package.json");

const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));

const release = process.argv[2] || "patch";
if (!["patch", "minor", "major"].includes(release)) {
  console.error(`Usage: node bump-version.js [patch|minor|major] (got: ${release})`);
  process.exit(1);
}

const [major, minor, patch] = pkg.version.split(".").map(Number);

let nextVersion = pkg.version;
if (release === "major") {
  nextVersion = `${major + 1}.0.0`;
} else if (release === "minor") {
  nextVersion = `${major}.${minor + 1}.0`;
} else {
  nextVersion = `${major}.${minor}.${patch + 1}`;
}

pkg.version = nextVersion;
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

console.log(`Bumped version to ${nextVersion}`);
