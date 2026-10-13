import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPiHostVersion, supportsActionableSettle, supportsCompactToolGuidance } from "./host-capabilities.js";

it("detects the installed ESM-only Pi host and enables the matching integration features", () => {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const metadata = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
  assert.equal(metadata.name, "@earendil-works/pi-coding-agent");
  assert.equal(getPiHostVersion(), metadata.version);
  const [major, minor] = metadata.version.split(".").map(Number);
  assert.equal(supportsActionableSettle(), major > 0 || (major === 0 && minor >= 87));
  assert.equal(supportsCompactToolGuidance(), major >= 1);
});
