import type { ReviewLevel } from "../types.js";

export function parseReviewCommandArgs(input: string): {
  description: string;
  options: {
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    vcs?: "git" | "svn";
    untracked?: boolean;
    level?: ReviewLevel;
  };
} {
  const options: {
    revision?: string;
    since?: string;
    files?: string[];
    exclude?: string[];
    vcs?: "git" | "svn";
    untracked?: boolean;
    level?: ReviewLevel;
  } = {};
  const tokens = input.match(/(?:[^\s"']+|["'][^"']*["'])+/g) ?? [];
  const args = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  const descriptionParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--revision":
      case "-r":
        if (next) {
          options.revision = next;
          i++;
        }
        break;
      case "--since":
      case "-s":
        if (next) {
          options.since = next;
          i++;
        }
        break;
      case "--files":
      case "-f":
        if (next) {
          options.files = next
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean);
          i++;
        }
        break;
      case "--exclude":
      case "-x":
        if (next) {
          options.exclude = next
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean);
          i++;
        }
        break;
      case "--vcs":
        if (next === "git" || next === "svn") {
          options.vcs = next;
          i++;
        }
        break;
      case "--untracked":
        options.untracked = true;
        break;
      case "--level":
      case "-l":
        if (next === "min" || next === "med" || next === "high") {
          options.level = next;
          i++;
        }
        break;
      default:
        descriptionParts.push(arg);
    }
  }

  return { description: descriptionParts.join(" ") || "review changes", options };
}

export function parseTestCommandArgs(input: string): {
  description: string;
  command?: string;
  options: {
    files?: string[];
    exclude?: string[];
    revision?: string;
    since?: string;
    vcs?: "git" | "svn";
    untracked?: boolean;
    level?: ReviewLevel;
  };
} {
  const base = parseReviewCommandArgs(input);
  const tokens = input.match(/(?:[^\s"']+|["'][^"']*["'])+/g) ?? [];
  const args = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  let command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--command" || args[i] === "-c") && args[i + 1]) {
      command = args[i + 1];
      i++;
    }
  }
  return { description: base.description, command, options: base.options };
}

export function parseSecurityCommandArgs(input: string): {
  description: string;
  options: {
    files?: string[];
    exclude?: string[];
    revision?: string;
    since?: string;
    vcs?: "git" | "svn";
    untracked?: boolean;
    fullProject?: boolean;
    level?: ReviewLevel;
  };
} {
  const base = parseReviewCommandArgs(input);
  const tokens = input.match(/(?:[^\s"']+|["'][^"']*["'])+/g) ?? [];
  const fullProject = tokens.some((t) => t === "--full-project" || t === "-fp");
  return { description: base.description, options: { ...base.options, fullProject } };
}

export type LearnCommandKind = "record" | "verify" | "stale" | "reaffirm" | "invalid";

export interface LearnCommandArgs {
  kind: LearnCommandKind;
  /** Record mode: the fact text (flags stripped). */
  fact?: string;
  category?: string;
  /** Verify/stale mode. */
  query?: string;
  deep?: boolean;
  /** Stale mode. */
  staleQuery?: string;
  /** Reaffirm mode: exact stored fact text. */
  reaffirmFact?: string;
  invalidReason?: string;
}

/** Quote-aware tokenization shared by the learn parser (quoted values keep
 *  their spaces; surrounding quotes are stripped per token). */
function tokenize(input: string): string[] {
  return (input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

/**
 * Parses /wai-learn arguments as a token state machine. Exactly one action is
 * allowed:
 *   record <fact> [--category <cat>] | --verify [--query <kw>] [--deep] |
 *   --stale [--query <kw>] | --reaffirm <exact fact text>
 * Every flag is validated against its mode; unknown flags, missing values,
 * flag-like values, and conflicting actions yield kind "invalid" with a
 * reason.
 */
export function parseLearnCommandArgs(input: string): LearnCommandArgs {
  const args = tokenize(input.trim());
  if (args.length === 0) {
    return { kind: "invalid", invalidReason: "Provide a fact or an action flag." };
  }

  const flagSet = new Set<string>();
  const flagCounts = new Map<string, number>();
  for (const a of args) {
    if (!a.startsWith("--")) continue;
    flagSet.add(a);
    flagCounts.set(a, (flagCounts.get(a) ?? 0) + 1);
  }
  const repeated = [...flagCounts.entries()].filter(([, n]) => n > 1);
  if (repeated.length > 0) {
    return { kind: "invalid", invalidReason: `Repeated flag(s): ${repeated.map(([f]) => f).join(" ")}` };
  }

  const actionsRequested = args.filter((a) => a === "--stale" || a === "--verify" || a === "--reaffirm");
  const actions = [...new Set(actionsRequested)];
  if (actionsRequested.length > 1) {
    return { kind: "invalid", invalidReason: `Conflicting actions: ${actions.join(" ")}` };
  }

  // Value-taking flags (never positional).
  const valueFlags = new Set(["--query", "--category"]);
  const takesValue = (f: string) => valueFlags.has(f);

  const unknown = [...flagSet].filter((f) => {
    if (f === "--stale" || f === "--verify" || f === "--reaffirm") return false;
    if (f === "--deep") return false;
    if (takesValue(f)) return false;
    return true;
  });
  if (unknown.length > 0) {
    return { kind: "invalid", invalidReason: `Unknown flag(s): ${unknown.join(" ")}` };
  }

  // Consume flag values from the positional stream (flags with values are
  // NOT positionals; each needs exactly one non-flag token after it).
  const values = new Map<string, string>();
  const factParts: string[] = [];
  let afterReaffirm = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!afterReaffirm && a.startsWith("--")) {
      if (takesValue(a)) {
        const next = args[i + 1];
        if (next === undefined || next.length === 0 || next.startsWith("--")) {
          return { kind: "invalid", invalidReason: `${a} requires a value.` };
        }
        values.set(a, next);
        i++; // consume the value
        continue;
      }
      if (a === "--reaffirm") afterReaffirm = true;
      continue;
    }
    if (afterReaffirm) {
      factParts.push(a);
    } else {
      factParts.push(a);
    }
  }

  const action = actions[0];
  if (action === "--reaffirm") {
    // --reaffirm must be the FIRST token: nothing may precede its fact text.
    const reaffirmIndex = args.indexOf("--reaffirm");
    if (reaffirmIndex !== 0) {
      return { kind: "invalid", invalidReason: "--reaffirm must be the first token." };
    }
    const rest = args.slice(reaffirmIndex + 1);
    if (rest.length === 0 || rest.every((r) => r.length === 0)) {
      return { kind: "invalid", invalidReason: "--reaffirm requires the exact fact text." };
    }
    if (rest.some((r) => r.startsWith("--"))) {
      return { kind: "invalid", invalidReason: "--reaffirm accepts its fact text only (no other flags)." };
    }
    return { kind: "reaffirm", reaffirmFact: rest.join(" ") };
  }

  const modeFlags = (allowed: string[]) => {
    const disallowed = [...flagSet].filter((f) => !allowed.includes(f) && f !== "--reaffirm");
    return disallowed.length > 0
      ? { kind: "invalid" as const, invalidReason: `Flag(s) not valid here: ${disallowed.join(" ")}` }
      : null;
  };

  if (action === "--verify") {
    if (args[0] !== "--verify") {
      return { kind: "invalid", invalidReason: "--verify must be the first token." };
    }
    const rejected = modeFlags(["--verify", "--query", "--deep"]);
    if (rejected) return rejected;
    if (factParts.length > 0) {
      return { kind: "invalid", invalidReason: `Unexpected positional argument(s): ${factParts.join(" ")}` };
    }
    return { kind: "verify", query: values.get("--query"), deep: flagSet.has("--deep") };
  }

  if (action === "--stale") {
    if (args[0] !== "--stale") {
      return { kind: "invalid", invalidReason: "--stale must be the first token." };
    }
    const rejected = modeFlags(["--stale", "--query"]);
    if (rejected) return rejected;
    if (factParts.length > 0) {
      return { kind: "invalid", invalidReason: `Unexpected positional argument(s): ${factParts.join(" ")}` };
    }
    return { kind: "stale", staleQuery: values.get("--query") };
  }

  // Record mode: an indexed pass skips exactly the token consumed by
  // --category (never another equal-looking positional), so
  // "same --category same" records fact "same" with category "same".
  const unknownRecord = [...flagSet].filter((f) => f !== "--category");
  if (unknownRecord.length > 0) {
    return { kind: "invalid", invalidReason: `Unknown flag(s): ${unknownRecord.join(" ")}` };
  }
  const fact: string[] = [];
  let category: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--category") {
      category = args[i + 1];
      i++; // skip the consumed value
      continue;
    }
    if (a.startsWith("--")) continue;
    fact.push(a);
  }
  if (fact.length === 0 || fact.join(" ").trim().length === 0) {
    return { kind: "invalid", invalidReason: "Provide a fact to record." };
  }
  return { kind: "record", fact: fact.join(" "), category };
}
