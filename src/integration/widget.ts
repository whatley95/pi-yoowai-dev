import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig } from "../config.js";
import { getBlockedBy, stepGlyph } from "../plan-view.js";
import { getState, getProgress } from "../session-state.js";
import { planStepDescription } from "../types.js";

export const INNER_WIDTH = 56;
const TOTAL_WIDTH = INNER_WIDTH + 4; // includes borders and side padding

/** Wide (2-column) code-point ranges — compact table covering CJK, Hangul,
 *  Kana, fullwidth forms, and common emoji blocks. Narrow/ambiguous count as
 *  1; zero-width modifiers (combining marks, variation selectors, skin tones)
 *  count 0. Good enough for widget framing without a full Unicode database. */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1faff],
  [0x1f1e6, 0x1f1ff],
  [0x20000, 0x3fffd],
];
const ZERO_RANGES: Array<[number, number]> = [
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0x1f3fb, 0x1f3ff],
  [0xe0100, 0xe01ef],
];
/** Legacy symbol blocks are Extended_Pictographic but render NARROW in most
 *  terminals (⚠ ✓ → ☺ …). Exclude them from the emoji-wide rule. */
const AMBIGUOUS_NARROW_RANGES: Array<[number, number]> = [[0x2600, 0x27bf]]; // Misc Symbols + Dingbats (✓ ⚠ → ·)

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

const MARK_RE = /[\p{M}\p{Cf}]/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

function codePointWidth(cp: number): number {
  if (inRanges(cp, ZERO_RANGES)) return 0;
  const ch = String.fromCodePoint(cp);
  if (MARK_RE.test(ch)) return 0; // all Unicode marks (incl. U+1AB0+) are zero-width
  if (inRanges(cp, WIDE_RANGES) || (EMOJI_RE.test(ch) && !inRanges(cp, AMBIGUOUS_NARROW_RANGES))) return 2; // incl. modern emoji (U+1FAE0…)
  return 1;
}

/** Grapheme segmentation (Node ≥ 16): ZWJ emoji, regional-indicator flags,
 *  and keycap sequences form single terminal graphemes, so width is measured
 *  per cluster, with a per-code-point fallback for hosts without it. */
const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Terminal display width of a string, measured per grapheme cluster: ZWJ
 *  emoji (👨‍👩‍👧‍👦), regional-indicator flags (🇺🇸), and keycaps count as one
 *  cluster (2 columns when pictographic/flag); wide/fullwidth characters
 *  count 2; marks count 0. */
export function displayWidth(text: string): number {
  if (graphemeSegmenter) {
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      // Cluster-level rule: keycap sequences (base + FE0F + 20E3) render ~2
      // columns even though the base may be a 1-column digit.
      if (segment.includes("\u{20E3}")) {
        width += 2;
        continue;
      }
      width += codePointWidth(segment.codePointAt(0)!);
    }
    return width;
  }
  let width = 0;
  for (const ch of text) {
    width += codePointWidth(ch.codePointAt(0)!);
  }
  return width;
}

/** Split text into grapheme clusters (Intl.Segmenter; per-code-point
 *  fallback) so wrapping and slicing never split a ZWJ emoji or flag. */
function toClusters(text: string): string[] {
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(text)].map((s) => s.segment);
  }
  return [...text];
}

/** Slice by terminal display columns (grapheme-cluster aligned), not UTF-16 units. */
function sliceToWidth(text: string, cols: number): string {
  let width = 0;
  let out = "";
  for (const cluster of toClusters(text)) {
    const w = displayWidth(cluster);
    if (width + w > cols) break;
    out += cluster;
    width += w;
  }
  return out;
}

function borderLine(left: string, fill: string, right: string): string {
  const fillCount = Math.max(0, TOTAL_WIDTH - displayWidth(left) - displayWidth(right));
  return left + fill.repeat(fillCount) + right;
}

/** Frame an inner line with side borders, padding to the widget width. */
function framed(inner: string): string {
  const clipped = sliceToWidth(inner, INNER_WIDTH);
  return `│ ${clipped}${" ".repeat(Math.max(0, INNER_WIDTH - displayWidth(clipped)))} │`;
}

/** Wrap text into framed lines by terminal display columns at word
 *  boundaries; content is never discarded. Continuation lines align under
 *  the first line's text. A prefix that cannot leave room for content falls
 *  back to the continuation lead for every line, so wrapping always
 *  progresses. */
function wrapInto(lines: string[], text: string, firstPrefix: string, continuation: string): void {
  let rest = text;
  let first = true;
  for (;;) {
    const useFirst = first && displayWidth(firstPrefix) < INNER_WIDTH;
    const lead = useFirst ? firstPrefix : continuation;
    const room = INNER_WIDTH - displayWidth(lead);
    if (room <= 0) {
      lines.push(framed(lead));
      return;
    }
    if (displayWidth(rest) <= room) {
      lines.push(framed(lead + rest));
      return;
    }
    // Find the widest word-boundary cut that fits the room, measuring columns.
    // Clusters (not code points) are the unit; cut is a CLUSTER index used
    // identically for rendering and removal, while the column accumulator
    // only decides where it fits.
    let cut = 0;
    let lastSpace = -1;
    let acc = 0;
    const clusters = toClusters(rest);
    for (let i = 0; i < clusters.length; i++) {
      const w = displayWidth(clusters[i]!);
      if (acc + w > room) break;
      if (clusters[i] === " ") lastSpace = i;
      acc += w;
      cut = i + 1;
    }
    if (lastSpace >= 0 && lastSpace < cut) cut = lastSpace + 1;
    lines.push(framed(lead + clusters.slice(0, cut).join("")));
    rest = clusters.slice(cut).join("").trimStart();
    first = false;
    if (cut === 0) return; // single cluster wider than the room — no progress guard
  }
}

/** Update the plan-progress widget above the editor.
 *  Shows the active plan summary, progress bar, the review ratio, and EVERY
 *  step with its status glyph (✓ reviewed / ⚠ done-not-reviewed / → current
 *  with blockers / · pending) — the full plan state without opening /wai-plan.
 *  Pass undefined content to hide the widget when no plan is active. */
export function updateWaiPlanWidget(ctx: ExtensionContext): void {
  if (!ctx.ui.setWidget) return;

  const config = loadYoowaiConfig(ctx.cwd);
  if (config.planWidget === false) {
    try {
      ctx.ui.setWidget("wai-plan", undefined);
    } catch {
      // ignore
    }
    return;
  }

  const state = getState(ctx.cwd);
  if (!state.plan || state.totalSteps === 0) {
    try {
      ctx.ui.setWidget("wai-plan", undefined);
    } catch {
      // ignore
    }
    return;
  }

  try {
    const plan = state.plan;
    const progress = getProgress(ctx.cwd);
    const total = progress.total;
    const completed = progress.completed;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    let reviewed = 0;
    for (let i = 0; i < completed; i++) {
      if (state.reviewedSteps[i]) reviewed++;
    }

    const barWidth = INNER_WIDTH - 5; // leave room for " NNN%"
    const filled = total > 0 ? Math.round((barWidth * completed) / total) : 0;
    const empty = Math.max(0, barWidth - filled);
    const bar = "█".repeat(filled) + "░".repeat(empty);

    const lines: string[] = [];
    lines.push(borderLine("┌─ wai plan ─", "─", "┐"));
    wrapInto(lines, plan.summary, "", "   ");
    lines.push(framed(`${bar} ${pct.toString().padStart(3)}%`));
    lines.push(framed(`${completed}/${total} steps · reviewed ${reviewed}/${completed}`));

    // Every step, in order, with the shared glyph language — per-step ⚠ marks
    // replace the old aggregate "done steps not reviewed" warning line.
    for (let i = 0; i < plan.todo.length; i++) {
      const description = planStepDescription(plan.todo[i]!);
      const glyph = stepGlyph(state, i);
      let annotation = "";
      if (i === completed && completed < total) {
        const blockedBy = getBlockedBy(state, i);
        if (blockedBy) annotation = ` — blocked by step ${blockedBy.join(", ")}`;
      }
      wrapInto(lines, `${description}${annotation}`, `${i + 1}. ${glyph} `, "        ");
    }
    lines.push(borderLine("└", "─", "┘"));

    ctx.ui.setWidget("wai-plan", lines);
  } catch {
    // best-effort widget update
  }
}

/** Hide the plan-progress widget. */
export function hideWaiPlanWidget(ctx: ExtensionContext): void {
  if (!ctx.ui.setWidget) return;
  try {
    ctx.ui.setWidget("wai-plan", undefined);
  } catch {
    // ignore
  }
}
