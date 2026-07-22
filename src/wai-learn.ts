import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadYoowaiConfig, resolveTaskModel } from "./config.js";
import { recordCost } from "./cost-tracker.js";
import { loadConventions, formatConventions } from "./conventions.js";
import { logEvent } from "./logger.js";
import { resolveProjectPath } from "./path-security.js";
import { getProjectConfigPath } from "./pi-paths.js";
import { loadProjectIndex } from "./project-index.js";
import { callSecondaryModel } from "./secondary-model.js";
import type { UsageCost } from "./types.js";

export interface LearnedFact {
  fact: string;
  category?: string;
  source?: string;
  timestamp: string;
}

export interface LearnedStore {
  facts: LearnedFact[];
  updatedAt: string;
}

const MAX_FACTS = 200;

function getLearnedPath(cwd: string): string {
  return getProjectConfigPath(cwd, "yoowai", "learned.json");
}

function loadLearned(cwd: string): LearnedStore {
  const path = getLearnedPath(cwd);
  if (!existsSync(path)) {
    return { facts: [], updatedAt: new Date().toISOString() };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (!isValidLearnedStore(data)) {
      logEvent(cwd, "warn", "Invalid learned facts file shape; ignoring", { path });
      return { facts: [], updatedAt: new Date().toISOString() };
    }
    return data;
  } catch (err) {
    logEvent(cwd, "warn", "Failed to load learned facts", {
      error: err instanceof Error ? err.message : String(err),
      path,
    });
    return { facts: [], updatedAt: new Date().toISOString() };
  }
}

function isValidLearnedStore(value: unknown): value is LearnedStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.facts)) return false;
  for (const f of v.facts) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false;
    const fact = f as Record<string, unknown>;
    if (typeof fact.fact !== "string") return false;
  }
  return true;
}

function saveLearned(cwd: string, store: LearnedStore): void {
  try {
    const path = getLearnedPath(cwd);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    store.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logEvent(cwd, "error", "Failed to save learned facts", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface RecordFactOptions {
  category?: string;
  source?: string;
}

export function recordLearnedFact(cwd: string, fact: string, options: RecordFactOptions = {}): LearnedFact {
  const store = loadLearned(cwd);
  const entry: LearnedFact = {
    fact: fact.trim(),
    category: options.category?.trim() || undefined,
    source: options.source?.trim() || undefined,
    timestamp: new Date().toISOString(),
  };
  store.facts.push(entry);
  if (store.facts.length > MAX_FACTS) {
    store.facts = store.facts.slice(-MAX_FACTS);
  }
  saveLearned(cwd, store);
  return entry;
}

export function loadLearnedFacts(cwd: string): LearnedFact[] {
  return loadLearned(cwd).facts;
}

export function findLearnedFacts(cwd: string, query?: string): LearnedFact[] {
  const facts = loadLearnedFacts(cwd);
  if (!query) return facts.slice().reverse();
  const q = query.toLowerCase();
  return facts
    .filter(
      (f) =>
        f.fact.toLowerCase().includes(q) ||
        (f.category && f.category.toLowerCase().includes(q)) ||
        (f.source && f.source.toLowerCase().includes(q)),
    )
    .slice()
    .reverse();
}

export function formatLearnedFacts(facts: LearnedFact[]): string {
  if (facts.length === 0) return "No learned facts recorded.";
  const lines: string[] = [];
  for (const f of facts) {
    const category = f.category ? ` [${f.category}]` : "";
    const source = f.source ? ` (source: ${f.source})` : "";
    lines.push(`-${category} ${f.fact}${source}`);
  }
  return lines.join("\n");
}

export function clearLearnedFacts(cwd: string): void {
  saveLearned(cwd, { facts: [], updatedAt: new Date().toISOString() });
}

export type VerificationStatus = "valid" | "questionable" | "outdated";

export interface LearnedFactVerification {
  fact: LearnedFact;
  status: VerificationStatus;
  reasons: string[];
}

function extractPaths(text: string): string[] {
  const matches = text.match(/\b(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g);
  return matches ?? [];
}

function loadDependencyNames(cwd: string): Set<string> {
  const names = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, "utf-8")) as Record<string, unknown>;
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = pkg[key] as Record<string, unknown> | undefined;
      if (deps && typeof deps === "object" && !Array.isArray(deps)) {
        for (const name of Object.keys(deps)) {
          names.add(name.toLowerCase());
        }
      }
    }
  } catch {
    // ignore missing/unreadable package.json
  }
  return names;
}

function loadSymbolNames(cwd: string): Set<string> {
  const index = loadProjectIndex(cwd);
  if (!index) return new Set();
  const names = new Set<string>();
  for (const file of index.files) {
    for (const symbol of file.symbols) {
      names.add(symbol.name.toLowerCase());
    }
  }
  return names;
}

function extractWords(text: string): string[] {
  return text.split(/[^a-zA-Z0-9_]+/).filter((w) => w.length > 1);
}

export function verifyLearnedFacts(cwd: string, query?: string): LearnedFactVerification[] {
  const facts = findLearnedFacts(cwd, query || undefined);
  const symbolNames = loadSymbolNames(cwd);
  const dependencyNames = loadDependencyNames(cwd);
  const results: LearnedFactVerification[] = [];

  for (const fact of facts) {
    const reasons: string[] = [];
    let status: VerificationStatus = "valid";

    const paths = extractPaths(fact.fact);
    for (const p of paths) {
      const resolved = resolveProjectPath(cwd, p);
      if (!resolved || !existsSync(resolved)) {
        status = "outdated";
        reasons.push(`Referenced file no longer exists: ${p}`);
      }
    }

    if (fact.source) {
      const resolved = resolveProjectPath(cwd, fact.source);
      if (!resolved || !existsSync(resolved)) {
        status = "outdated";
        reasons.push(`Source file no longer exists: ${fact.source}`);
      }
    }

    const words = extractWords(fact.fact);
    for (const word of words) {
      const lower = word.toLowerCase();
      if (dependencyNames.has(lower)) {
        continue;
      }
      if (symbolNames.size > 0 && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(word) && symbolNames.has(lower)) {
        continue;
      }
      if (
        symbolNames.size > 0 &&
        /^[a-zA-Z][a-zA-Z0-9_]*$/.test(word) &&
        !symbolNames.has(lower) &&
        looksLikeIdentifier(word)
      ) {
        status = status === "outdated" ? "outdated" : "questionable";
        reasons.push(`Symbol "${word}" was not found in the project index`);
      }
    }

    results.push({ fact, status, reasons });
  }

  return results;
}

function looksLikeIdentifier(word: string): boolean {
  // Only treat words that look like code identifiers (camelCase, PascalCase, snake_case)
  // and are not common English words as potential symbol references.
  if (word.length < 2) return false;
  const lower = word.toLowerCase();
  if (/^[a-z]+$/.test(word)) return false;
  const common = new Set([
    "the",
    "and",
    "for",
    "are",
    "but",
    "not",
    "you",
    "all",
    "can",
    "had",
    "her",
    "was",
    "one",
    "our",
    "out",
    "day",
    "get",
    "has",
    "him",
    "his",
    "how",
    "man",
    "new",
    "now",
    "old",
    "see",
    "two",
    "way",
    "who",
    "boy",
    "did",
    "its",
    "let",
    "put",
    "say",
    "she",
    "too",
    "use",
    "with",
    "have",
    "this",
    "will",
    "your",
    "from",
    "they",
    "know",
    "want",
    "been",
    "good",
    "much",
    "some",
    "time",
    "very",
    "when",
    "come",
    "here",
    "just",
    "like",
    "long",
    "make",
    "many",
    "over",
    "such",
    "take",
    "than",
    "them",
    "well",
    "were",
    "use",
    "call",
    "set",
    "get",
    "add",
    "put",
    "make",
    "take",
    "from",
    "with",
    "when",
    "then",
    "than",
    "them",
    "they",
    "this",
    "that",
    "there",
    "their",
    "where",
    "which",
    "while",
    "because",
    "before",
    "after",
    "during",
    "within",
    "without",
    "about",
    "above",
    "across",
    "against",
    "along",
    "around",
    "under",
    "into",
    "onto",
    "upon",
    "through",
    "throughout",
    "between",
    "among",
    "until",
    "unless",
    "since",
    "although",
    "though",
    "however",
    "therefore",
    "moreover",
    "otherwise",
    "instead",
    "besides",
    "also",
    "very",
    "just",
    "only",
    "even",
    "still",
    "already",
    "yet",
    "once",
    "twice",
    "here",
    "everywhere",
    "somewhere",
    "anywhere",
    "nowhere",
    "always",
    "never",
    "sometimes",
    "often",
    "usually",
    "rarely",
    "seldom",
    "again",
    "back",
    "down",
    "up",
    "off",
    "on",
    "in",
    "further",
  ]);
  if (common.has(lower)) return false;
  return true;
}

export function formatVerificationReport(results: LearnedFactVerification[]): string {
  if (results.length === 0) return "No learned facts to verify.";

  const outdated = results.filter((r) => r.status === "outdated");
  const questionable = results.filter((r) => r.status === "questionable");
  const valid = results.filter((r) => r.status === "valid");

  const lines: string[] = [];
  lines.push(
    `Verified ${results.length} fact(s): ${valid.length} valid, ${questionable.length} questionable, ${outdated.length} outdated.`,
  );

  if (outdated.length > 0) {
    lines.push("\nOutdated:");
    for (const r of outdated) {
      lines.push(`- ${r.fact.fact}`);
      for (const reason of r.reasons) lines.push(`  - ${reason}`);
    }
  }

  if (questionable.length > 0) {
    lines.push("\nQuestionable:");
    for (const r of questionable) {
      lines.push(`- ${r.fact.fact}`);
      for (const reason of r.reasons) lines.push(`  - ${reason}`);
    }
  }

  if (valid.length > 0) {
    lines.push("\nValid:");
    for (const r of valid) {
      lines.push(`- ${r.fact.fact}`);
    }
  }

  return lines.join("\n");
}

function mergeCost(a: UsageCost, b: UsageCost): UsageCost {
  return {
    estimatedInputTokens: a.estimatedInputTokens + b.estimatedInputTokens,
    estimatedOutputTokens: a.estimatedOutputTokens + b.estimatedOutputTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    sessionCostUsd: Math.max(a.sessionCostUsd, b.sessionCostUsd),
  };
}

function buildDeepVerifyPrompt(
  fact: LearnedFact,
  conventions?: string,
  fileContent?: string,
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const fileBlock = fileContent ? `\n<file_contents>\n${fileContent}\n</file_contents>` : "";
  return {
    system: `You are verifying whether a stored project fact is still accurate against the current codebase.

Classify the fact as one of:
- valid: the fact is still supported by the code
- questionable: the fact may be stale, partially true, or lacks supporting evidence
- outdated: the fact is no longer true (e.g. referenced file/symbol removed, behavior changed)

Return exactly:
STATUS: <valid|questionable|outdated>
REASON: <one concise sentence>`,

    user: `Fact: ${fact.fact}${fact.category ? `\nCategory: ${fact.category}` : ""}${
      fact.source ? `\nSource: ${fact.source}` : ""
    }${conventionsBlock}${fileBlock}\n\nIs this fact still accurate?`,
  };
}

function parseDeepVerifyResponse(raw: string): { status: VerificationStatus; reason: string } {
  const statusMatch = raw.match(/STATUS:\s*(valid|questionable|outdated)/i);
  const reasonMatch = raw.match(/REASON:\s*(.+)/i);
  const status = (statusMatch?.[1].toLowerCase() as VerificationStatus) ?? "valid";
  const reason = reasonMatch?.[1].trim() ?? "No reason provided.";
  return { status, reason };
}

export type DeepVerifyModelCaller = (system: string, user: string) => Promise<{ content: string; usage: UsageCost }>;

export async function verifyLearnedFactsDeep(
  cwd: string,
  query: string | undefined,
  signal: AbortSignal | undefined,
  onProgress: (current: number, total: number) => void,
  sessionManager?: {
    getHeader(): unknown;
    getBranch(): unknown[];
  },
  callModel?: DeepVerifyModelCaller,
): Promise<{ results: LearnedFactVerification[]; cost: UsageCost }> {
  const config = loadYoowaiConfig(cwd);
  const modelConfig = resolveTaskModel(config, "explain");
  if (!callModel && (!modelConfig.provider || !modelConfig.id)) {
    throw new Error("No secondary model configured. Set pi-yoowai.secondary in settings.json.");
  }

  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";
  const facts = findLearnedFacts(cwd, query || undefined);
  const results: LearnedFactVerification[] = [];
  let totalCost: UsageCost = {
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedCostUsd: 0,
    sessionCostUsd: 0,
  };

  const caller: DeepVerifyModelCaller =
    callModel ??
    ((system, user) =>
      callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
        signal,
        thinking: modelConfig.thinking,
        cwd,
        sessionManager,
        task: "explain",
      }));

  for (let i = 0; i < facts.length; i++) {
    onProgress(i + 1, facts.length);
    const fact = facts[i];

    let fileContent: string | undefined;
    if (fact.source) {
      const safePath = resolveProjectPath(cwd, fact.source);
      if (safePath && existsSync(safePath)) {
        try {
          const content = readFileSync(safePath, "utf-8");
          fileContent = content.length > 100 * 1024 ? `${content.slice(0, 100 * 1024)}\n...` : content;
        } catch {
          // ignore unreadable source
        }
      }
    }

    const { system, user } = buildDeepVerifyPrompt(fact, conventionsText, fileContent);
    const { content: raw, usage } = await caller(system, user);

    totalCost = mergeCost(totalCost, usage);
    const { status, reason } = parseDeepVerifyResponse(raw);
    results.push({ fact, status, reasons: [reason] });
  }

  const cost = recordCost(cwd, totalCost, config.costBudgetUsd);
  logEvent(cwd, "info", "Deep learned-fact verification completed", {
    factsChecked: facts.length,
    provider: modelConfig.provider,
    model: modelConfig.id,
  });

  return { results, cost };
}
