import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The actionable settle boundary was introduced in Pi 0.87. */
export function supportsActionableSettle(): boolean {
  try {
    let directory = dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent"));
    for (;;) {
      try {
        const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (metadata.name === "@earendil-works/pi-coding-agent") {
          const [major, minor] = String(metadata.version).split(".").map(Number);
          return major > 0 || minor >= 87;
        }
      } catch {
        /* keep looking for the package root */
      }
      const parent = dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  } catch {
    return false;
  }
}
