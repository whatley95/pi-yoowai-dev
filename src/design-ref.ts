import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent } from "./logger.js";
import { resolveProjectPath } from "./path-security.js";
import { getProjectConfigPath } from "./pi-paths.js";
import { estimateTokens } from "./token-budget.js";
import { seedDefaultDesignRules } from "./design-ref-defaults.js";

export interface DesignRule {
  rule: string;
  source?: string;
  timestamp: string;
}

export interface DesignRefStore {
  rules: DesignRule[];
  updatedAt: string;
}

export const MAX_RULES = 100;

/** File extensions treated as UI code for design-rule injection. */
export const UI_FILE_PATTERN = /\.(tsx|jsx|css|scss|sass|less|svelte|vue|html)$/i;

export function isUiFile(path: string): boolean {
  return UI_FILE_PATTERN.test(path);
}

function getDesignRefPath(cwd: string): string {
  return getProjectConfigPath(cwd, "yoowai", "design-ref.json");
}

function isValidDesignRefStore(value: unknown): value is DesignRefStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.rules)) return false;
  for (const r of v.rules) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return false;
    const rule = r as Record<string, unknown>;
    if (typeof rule.rule !== "string") return false;
  }
  return true;
}

function loadStore(cwd: string): DesignRefStore {
  const path = getDesignRefPath(cwd);
  if (!existsSync(path)) {
    return { rules: [], updatedAt: new Date().toISOString() };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!isValidDesignRefStore(data)) {
      logEvent(cwd, "warn", "Invalid design reference file shape; ignoring", { path });
      return { rules: [], updatedAt: new Date().toISOString() };
    }
    return data;
  } catch (err) {
    logEvent(cwd, "warn", "Failed to load design references", {
      error: err instanceof Error ? err.message : String(err),
      path,
    });
    return { rules: [], updatedAt: new Date().toISOString() };
  }
}

function saveStore(cwd: string, store: DesignRefStore): void {
  try {
    const path = getDesignRefPath(cwd);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    store.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logEvent(cwd, "error", "Failed to save design references", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function addDesignRule(cwd: string, rule: string, source?: string): DesignRule {
  const text = rule.trim();
  const store = loadStore(cwd);
  const existing = store.rules.find((r) => r.rule.toLowerCase() === text.toLowerCase());
  if (existing) return existing;
  const entry: DesignRule = {
    rule: text,
    source: source?.trim() || undefined,
    timestamp: new Date().toISOString(),
  };
  store.rules.push(entry);
  if (store.rules.length > MAX_RULES) {
    store.rules = store.rules.slice(-MAX_RULES);
  }
  saveStore(cwd, store);
  return entry;
}

export function removeDesignRule(cwd: string, index: number): DesignRule | undefined {
  const store = loadStore(cwd);
  if (!Number.isInteger(index) || index < 1 || index > store.rules.length) return undefined;
  const [removed] = store.rules.splice(index - 1, 1);
  saveStore(cwd, store);
  return removed;
}

export function clearDesignRules(cwd: string): void {
  saveStore(cwd, { rules: [], updatedAt: new Date().toISOString() });
}

/** Read the store without triggering default seeding (used by the seeding
 *  logic itself and by tests that need the raw persisted state). */
export function peekDesignRules(cwd: string): DesignRule[] {
  return loadStore(cwd).rules;
}

export function loadDesignRules(cwd: string): DesignRule[] {
  const rules = loadStore(cwd).rules;
  if (rules.length > 0) return rules;
  // Lazy seeding: an empty/missing store gets the distilled defaults so the
  // feature works out of the box with zero commands. Never throws.
  try {
    if (seedDefaultDesignRules(cwd)) {
      return loadStore(cwd).rules;
    }
  } catch {
    // seeding is best-effort; fall through to the empty store
  }
  return rules;
}

export function formatDesignRules(rules: DesignRule[]): string {
  if (rules.length === 0) return "No design rules recorded.";
  return rules.map((r) => `- ${r.rule}`).join("\n");
}

export function formatDesignRulesForPrompt(cwd: string, maxTokens: number): string {
  try {
    if (maxTokens <= 0) return "";
    const rules = loadDesignRules(cwd);
    if (rules.length === 0) return "";
    const text = rules.map((r) => `- ${r.rule}`).join("\n");
    if (estimateTokens(text) <= maxTokens) return text;
    // Truncate on whole-line boundaries so the bullet list stays parseable.
    const maxChars = maxTokens * 4;
    const sliced = text.slice(0, maxChars);
    const lastNewline = sliced.lastIndexOf("\n");
    return lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
  } catch {
    return "";
  }
}

const MIN_RULE_CHARS = 8;
const MAX_RULE_CHARS = 300;

function extractRulesFromMarkdown(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const rules: string[] = [];
  let inFence = false;
  let inFrontmatter = false;
  let frontmatterChecked = false;
  let underHeading = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Frontmatter only counts as the very first block of the file.
    if (!frontmatterChecked) {
      frontmatterChecked = true;
      if (line === "---") {
        inFrontmatter = true;
        continue;
      }
    }
    if (inFrontmatter) {
      if (line === "---") inFrontmatter = false;
      continue;
    }

    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^#{1,6}\s/.test(line)) {
      underHeading = true;
      continue;
    }

    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    let text: string | undefined;
    if (bullet) {
      text = bullet[1];
    } else if (underHeading && line.length > 0) {
      text = line;
    }
    if (text === undefined) continue;

    text = text.replace(/^\[[ xX]\]\s*/, "").trim();
    if (text.length < MIN_RULE_CHARS || text.length > MAX_RULE_CHARS) continue;
    rules.push(text);
  }

  return rules;
}

export function importDesignRules(cwd: string, relativePath: string): { imported: number; skipped: number } {
  const resolved = resolveProjectPath(cwd, relativePath);
  if (!resolved) {
    throw new Error(`Unsafe path: ${relativePath}. Design rule imports must stay inside the project.`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`Design rule file not found: ${relativePath}`);
  }
  const content = readFileSync(resolved, "utf-8");
  const candidates = extractRulesFromMarkdown(content);
  // Use the raw store here: importing user rules must not trigger default seeding.
  const before = new Set(peekDesignRules(cwd).map((r) => r.rule.toLowerCase()));
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (before.has(key) || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    addDesignRule(cwd, candidate, relativePath);
    imported++;
  }
  return { imported, skipped };
}

// --- Vendored design reference docs (design-refs/, Emil Kowalski's skills, MIT) ---

/** Absolute path of the vendored design-refs directory shipped with the
 *  package (src/ sits one level below the package root). */
function getDesignRefsDir(): string {
  return fileURLToPath(new URL("../design-refs", import.meta.url));
}

/** One-line descriptions shown when listing topics. */
export const DESIGN_REF_TOPIC_DESCRIPTIONS: Record<string, string> = {
  animate: "build an animation from scratch with correct curve/duration/properties",
  "animation-vocabulary": "precise words to describe motion",
  "apple-design": "Apple's interface-design and fluid-motion principles for the web",
  "emil-design-eng": "broad design-engineering taste (animation + design advice)",
  "find-animation-opportunities": "where motion genuinely helps, and what not to animate",
  "improve-animations": "audit and prioritized fix plans for existing animations",
  "pick-ui-library": "trusted UI library picks",
  prototype: "build and compare multiple UI variants",
  "review-animations": "strict animation review checklist and standards",
};

/** List the vendored topics and their markdown docs (SKILL.md first).
 *  Returns an empty array when the vendored directory is missing. */
export function listDesignRefDocs(): { topic: string; docs: string[] }[] {
  try {
    const root = getDesignRefsDir();
    if (!existsSync(root)) return [];
    const topics: { topic: string; docs: string[] }[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const docs = readdirSync(join(root, entry.name))
        .filter((f) => f.toLowerCase().endsWith(".md"))
        .sort((a, b) => {
          // SKILL.md first, then alphabetical.
          if (a === "SKILL.md") return -1;
          if (b === "SKILL.md") return 1;
          return a.localeCompare(b);
        });
      if (docs.length > 0) topics.push({ topic: entry.name, docs });
    }
    return topics.sort((a, b) => a.topic.localeCompare(b.topic));
  } catch {
    return [];
  }
}

/** Read a vendored design doc, truncated to maxTokens. Defaults to the
 *  topic's SKILL.md. Throws on unknown topic/doc; doc names are restricted
 *  to the topic's listed .md files and the resolved path must stay inside
 *  design-refs. */
export function readDesignRefDoc(topic: string, doc?: string, maxTokens = 6000): string {
  const topics = listDesignRefDocs();
  const available = topics.map((t) => t.topic).join(", ") || "(none — design-refs directory missing)";
  const entry = topics.find((t) => t.topic === topic);
  if (!entry) {
    throw new Error(`Unknown design reference topic "${topic}". Available topics: ${available}`);
  }
  const docName = doc ?? (entry.docs.includes("SKILL.md") ? "SKILL.md" : entry.docs[0]);
  if (!docName || !entry.docs.includes(docName)) {
    throw new Error(`Unknown doc "${doc ?? ""}" for topic "${topic}". Available docs: ${entry.docs.join(", ")}`);
  }
  const root = getDesignRefsDir();
  const resolved = resolve(root, topic, docName);
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new Error(`Unsafe design reference path: ${topic}/${docName}`);
  }
  let content = readFileSync(resolved, "utf-8");
  if (maxTokens > 0 && estimateTokens(content) > maxTokens) {
    const marker = `\n\n… (truncated to ${maxTokens} tokens; read a specific doc or section for more)`;
    content = `${content.slice(0, Math.max(0, maxTokens * 4 - marker.length))}${marker}`;
  }
  return content;
}
