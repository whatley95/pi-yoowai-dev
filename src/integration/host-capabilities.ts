import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The actionable settle boundary was introduced in Pi 0.87. */
export function getPiHostVersion(): string | undefined {
  try {
    // Pi exports its entry point under the ESM import condition. CommonJS
    // require.resolve can reject that export and silently disable host features.
    let directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    for (;;) {
      try {
        const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (metadata.name === "@earendil-works/pi-coding-agent") {
          return typeof metadata.version === "string" ? metadata.version : undefined;
        }
      } catch {
        /* keep looking for the package root */
      }
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    return undefined;
  }
}

export function supportsActionableSettle(): boolean {
  const [major, minor] = (getPiHostVersion() ?? "").split(".").map(Number);
  return major > 0 || (major === 0 && minor >= 87);
}

/** Keep legacy prompt guidance on hosts without the tested namespace contract. */
export function supportsCompactToolGuidance(): boolean {
  const major = Number((getPiHostVersion() ?? "").split(".")[0]);
  return Number.isInteger(major) && major >= 1;
}
