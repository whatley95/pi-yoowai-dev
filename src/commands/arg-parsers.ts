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
