import { existsSync, readFileSync } from "node:fs";
import { estimateTokens } from "./token-budget.js";
import type { ReviewBudget } from "./token-budget.js";
import { resolveProjectPath } from "./path-security.js";

export interface FileContentEntry {
  file: string;
  content: string;
  mode: "full" | "diff-only" | "outline";
  lineCount: number;
  tokenEstimate: number;
}

const GENERATED_PATTERNS = [
  /\.(min\.|generated\.)[a-z]+$/i,
  /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|eot|mp3|mp4|wav|avi|mov|pdf|zip|tar|gz|rar|7z|exe|dll|so|dylib|bin|map|log)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock|npm-shrinkwrap\.json)$/i,
  /(^|\/)(dist|build|out|coverage|node_modules|\.pi|\.git)\//i,
];

export function isReviewableFile(file: string): boolean {
  return !GENERATED_PATTERNS.some((p) => p.test(file));
}

export interface LoadFileContentsOptions {
  cwd: string;
  changedFiles: string[];
  budget: ReviewBudget;
  strategy: "auto" | "diff-only" | "full-files";
  fullFileThresholdLines: number;
}

export function loadFileContentsForReview(options: LoadFileContentsOptions): {
  entries: FileContentEntry[];
  dropped: string[];
  totalTokens: number;
} {
  const { cwd, changedFiles, budget, strategy, fullFileThresholdLines } = options;
  const reviewable = changedFiles.filter(isReviewableFile);
  const dropped: string[] = changedFiles.filter((f) => !reviewableFilesSet(reviewable, f));

  if (strategy === "diff-only") {
    return { entries: [], dropped, totalTokens: 0 };
  }

  // Load full content for each reviewable file and estimate tokens.
  const loaded: Array<FileContentEntry & { preferFull: boolean }> = [];
  for (const file of reviewable) {
    const safePath = resolveProjectPath(cwd, file);
    if (!safePath) {
      dropped.push(file);
      continue;
    }
    const content = readTextFile(safePath);
    if (content === null) {
      dropped.push(file);
      continue;
    }
    const lineCount = content.split(/\r?\n/).length;
    const tokenEstimate = estimateTokens(content);
    const preferFull = strategy === "full-files" || lineCount <= fullFileThresholdLines;
    loaded.push({ file, content, mode: preferFull ? "full" : "outline", lineCount, tokenEstimate, preferFull });
  }

  // Sort: prefer full files first (small ones), then by line count ascending.
  loaded.sort((a, b) => {
    if (a.preferFull && !b.preferFull) return -1;
    if (!a.preferFull && b.preferFull) return 1;
    return a.lineCount - b.lineCount;
  });

  const entries: FileContentEntry[] = [];
  let totalTokens = 0;
  const cap = Math.min(budget.hardInputCap ?? Infinity, budget.availableInputTokens);

  for (const item of loaded) {
    // Full files within budget; outlines for large files if budget allows.
    if (item.preferFull && totalTokens + item.tokenEstimate <= cap) {
      entries.push({
        file: item.file,
        content: item.content,
        mode: "full",
        lineCount: item.lineCount,
        tokenEstimate: item.tokenEstimate,
      });
      totalTokens += item.tokenEstimate;
    } else if (!item.preferFull) {
      const outline = generateOutline(item.content);
      const outlineTokens = estimateTokens(outline);
      if (totalTokens + outlineTokens <= cap) {
        entries.push({
          file: item.file,
          content: outline,
          mode: "outline",
          lineCount: item.lineCount,
          tokenEstimate: outlineTokens,
        });
        totalTokens += outlineTokens;
      } else {
        dropped.push(item.file);
      }
    } else {
      // Full file doesn't fit; try outline.
      const outline = generateOutline(item.content);
      const outlineTokens = estimateTokens(outline);
      if (totalTokens + outlineTokens <= cap) {
        entries.push({
          file: item.file,
          content: outline,
          mode: "outline",
          lineCount: item.lineCount,
          tokenEstimate: outlineTokens,
        });
        totalTokens += outlineTokens;
      } else {
        dropped.push(item.file);
      }
    }
  }

  return { entries, dropped, totalTokens };
}

function reviewableFilesSet(reviewable: string[], file: string): boolean {
  return reviewable.includes(file);
}

function readTextFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function generateOutline(content: string): string {
  const lines = content.split(/\r?\n/);
  const outline: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Capture structural lines: imports, exports, class/function declarations, major comments.
    if (
      /^(import|export|class|interface|type|function|const|let|var|async function|public|private|protected|static|#)/.test(
        trimmed,
      ) ||
      /^\/(\/|\*|\*)/.test(trimmed)
    ) {
      outline.push(line);
    }
  }
  return outline.slice(0, 200).join("\n");
}
