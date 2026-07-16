import { Value } from "@sinclair/typebox/value";
import type {
  PlanResult,
  ReviewResult,
  ReviewIssue,
  SuggestResult,
  RecommendResult,
  JudgeResult,
  Conventions,
  TestResult,
  SecurityResult,
} from "../types.js";
import {
  PlanResultSchema,
  ReviewResultSchema,
  SuggestResultSchema,
  RecommendResultSchema,
  JudgeResultSchema,
  ConventionsSchema,
  TestResultSchema,
  SecurityResultSchema,
} from "../schemas.js";

export function parseJsonResponse<T>(text: string): T | null {
  // Strip BOM and normalize line endings.
  const cleaned = text.replace(/^\uFEFF/, "").trim();

  // Try the whole text first (strict, then lenient repair).
  const parsed: unknown = tryParseJson(cleaned);

  // Unwrap common LLM wrapper objects like { "response": "..." }.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed);
    if (keys.length === 1) {
      const key = keys[0];
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && ["response", "answer", "result", "content", "data"].includes(key)) {
        const unwrapped = parseJsonResponse<T>(value);
        if (unwrapped !== null) return unwrapped;
      }
    }
  }

  if (parsed !== undefined) {
    try {
      return parsed as T;
    } catch {
      /* continue */
    }
  }

  // Prefer the explicit structured-output section used by the prompts.
  const resultFence = cleaned.match(/(?:^|\n)##\s*Result\s*\n+```(?:json)?\s*([\s\S]*?)```/i);
  if (resultFence) {
    const candidate = tryParseJson(resultFence[1].trim());
    if (candidate !== undefined) return candidate as T;
  }

  // Try each markdown code fence.
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(cleaned)) !== null) {
    const candidate = tryParseJson(fenceMatch[1].trim());
    if (candidate !== undefined) return candidate as T;
  }

  // Try inline backtick fences, but only for content that looks like JSON.
  const inlineRegex = /`([\s\S]*?)`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRegex.exec(cleaned)) !== null) {
    const trimmed = inlineMatch[1].trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    const candidate = tryParseJson(trimmed);
    if (candidate !== undefined) return candidate as T;
  }

  // Find the largest balanced JSON object in the text, respecting strings.
  const json = extractLargestJsonObject(cleaned);
  if (json) {
    const candidate = tryParseJson(json);
    if (candidate !== undefined) return candidate as T;
  }

  return null;
}

function extractLargestJsonObject(text: string): string | null {
  let best: string | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          if (!best || candidate.length > best.length) {
            best = candidate;
          }
        }
      }
    }
  }
  return best;
}

/**
 * Lenient repair of near-valid JSON produced by LLMs. String-aware single pass:
 * strips line and block comments, normalizes single-quoted strings to double quotes,
 * quotes bare object keys, and drops trailing commas. Only invoked when JSON.parse
 * fails, so mangling non-JSON prose is harmless (it simply still won't parse).
 */
function repairJson(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c: string): boolean => /[\w$]/.test(c);
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n) {
    const ch = input[i];
    if (isWs(ch)) {
      out += ch;
      i++;
      continue;
    }
    // Line comment // ... \n
    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    // Block comment /* ... */
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String literal (double or single quoted).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += '"';
      i++;
      while (i < n) {
        const c = input[i];
        if (c === "\\") {
          // Inside single-quoted strings, unescape \' to ' (\' is invalid JSON).
          if (quote === "'" && input[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          out += c;
          if (i + 1 < n) {
            out += input[i + 1];
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        if (c === quote) {
          out += '"';
          i++;
          break;
        }
        // Escape embedded double quotes when the source used single quotes.
        if (c === '"' && quote === "'") {
          out += '\\"';
          i++;
          continue;
        }
        out += c;
        i++;
      }
      continue;
    }
    // Bare identifier: could be a key (ident followed by optional ws then ':') or a literal.
    if (isIdentStart(ch)) {
      let j = i;
      let ident = "";
      while (j < n && isIdentPart(input[j])) {
        ident += input[j];
        j++;
      }
      let k = j;
      while (k < n && isWs(input[k])) k++;
      if (input[k] === ":") {
        out += '"' + ident + '"';
        i = j;
        continue;
      }
      out += ident;
      i = j;
      continue;
    }
    // Trailing comma before } or ]: drop it.
    if (ch === ",") {
      let k = i + 1;
      while (k < n && isWs(input[k])) k++;
      if (input[k] === "}" || input[k] === "]") {
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Try strict JSON.parse first, then a lenient repair pass. Returns undefined if both fail. */
function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to repair */
  }
  try {
    return JSON.parse(repairJson(text));
  } catch {
    return undefined;
  }
}

function castOrNull<T>(schema: Parameters<typeof Value.Cast>[0], data: unknown): T | null {
  try {
    // Prefer a plain Check when the data already matches; Cast can fail or mutate unexpectedly
    // on some provider responses (e.g., extra fields, proxy objects).
    if (Value.Check(schema, data)) {
      return data as T;
    }
    const cast = Value.Cast(schema, data);
    if (Value.Check(schema, cast)) {
      return cast as T;
    }
  } catch {
    /* invalid */
  }
  return null;
}

export function validatePlanResult(data: unknown): PlanResult | null {
  return castOrNull<PlanResult>(PlanResultSchema, data);
}

// The secondary model sometimes returns null or descriptive text for issue fields.
// Remove those so downstream code always sees the expected types or nothing.
function normalizeIssueFields(issues: ReviewIssue[]): void {
  for (const issue of issues) {
    if (typeof issue.file !== "string") {
      delete issue.file;
    }
    if (typeof issue.line !== "number") {
      delete issue.line;
    }
  }
}

export function validateReviewResult(data: unknown): ReviewResult | null {
  const result = castOrNull<ReviewResult>(ReviewResultSchema, data);
  if (!result) return null;
  normalizeIssueFields(result.issues);
  // Consensus is meaningful only when the verdict is pass and no issues remain.
  result.consensus = result.verdict === "pass" && result.issues.length === 0;
  return result;
}

export function validateSuggestResult(data: unknown): SuggestResult | null {
  return castOrNull<SuggestResult>(SuggestResultSchema, data);
}

export function validateRecommendResult(data: unknown): RecommendResult | null {
  return castOrNull<RecommendResult>(RecommendResultSchema, data);
}

export function validateJudgeResult(data: unknown): JudgeResult | null {
  const result = castOrNull<JudgeResult>(JudgeResultSchema, data);
  if (!result) return null;
  normalizeIssueFields(result.issues);
  if (result.completedStepIds) {
    result.completedStepIds = Array.from(
      new Set(result.completedStepIds.filter((id) => typeof id === "number" && Number.isFinite(id) && id >= 1)),
    ).sort((a, b) => a - b);
    if (result.completedStepIds.length === 0) {
      delete result.completedStepIds;
    }
  }
  return result;
}

function normalizeTestFindingFields(findings: import("../types.js").TestFinding[]): void {
  for (const finding of findings) {
    if (typeof finding.file !== "string") {
      delete finding.file;
    }
    if (typeof finding.line !== "number") {
      delete finding.line;
    }
    if (typeof finding.category !== "string") {
      delete finding.category;
    }
  }
}

function normalizeSecurityFindingFields(findings: import("../types.js").SecurityFinding[]): void {
  for (const finding of findings) {
    if (typeof finding.file !== "string") {
      delete finding.file;
    }
    if (typeof finding.line !== "number") {
      delete finding.line;
    }
  }
}

function normalizeMissingTests(missing: import("../types.js").MissingTest[]): void {
  for (const item of missing) {
    if (typeof item.file !== "string") {
      delete item.file;
    }
  }
}

export function validateTestResult(data: unknown): TestResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const result = castOrNull<TestResult>(TestResultSchema, data);
  if (!result) return null;
  normalizeTestFindingFields(result.findings);
  normalizeMissingTests(result.missingTests);
  return result;
}

export function validateSecurityResult(data: unknown): SecurityResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const result = castOrNull<SecurityResult>(SecurityResultSchema, data);
  if (!result) return null;
  normalizeSecurityFindingFields(result.findings);
  return result;
}

export function validateConventionsResult(data: unknown): Conventions | null {
  const result = castOrNull<Conventions>(ConventionsSchema, data);
  if (!result) return null;
  // Preserve an existing timestamp; only set a new one when the model omitted it.
  const incoming =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).generatedAt
      : undefined;
  result.generatedAt = typeof incoming === "string" ? incoming : new Date().toISOString();
  return result;
}

export function getJsonParseError(text: string): string | null {
  try {
    JSON.parse(text.trim());
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function formatValidationErrors(
  schema: Parameters<typeof Value.Errors>[0],
  data: unknown,
): Array<{ path: string; message: string; value: unknown }> {
  return [...Value.Errors(schema, data)].map((e) => ({
    path: e.path,
    message: e.message,
    value: e.value,
  }));
}

export function getReviewValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(ReviewResultSchema, data);
}

export function getSuggestValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(SuggestResultSchema, data);
}

export function getRecommendValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(RecommendResultSchema, data);
}

export function getJudgeValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(JudgeResultSchema, data);
}

export function getPlanValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(PlanResultSchema, data);
}

export function getTestValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(TestResultSchema, data);
}

export function getSecurityValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(SecurityResultSchema, data);
}
