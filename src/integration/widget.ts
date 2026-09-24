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
  [0x1f900, 0x1faff],
  [0x1f1e6, 0x1f1ff],
  [0x2329, 0x232a],
  [0x1b000, 0x1b122],
  [0x20000, 0x3fffd],
];
const ZERO_RANGES: Array<[number, number]> = [
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0x1f3fb, 0x1f3ff],
  [0xe0100, 0xe01ef],
];
/** Legacy symbol glyphs listed here (⚠ ✓ ✗ ☺, ballot boxes) render NARROW in
 *  most terminals; other symbols in the block follow the Emoji_Presentation
 *  or VS16 rules below (e.g. ✅ U+2705 and ❤+VS16 render wide). → (U+2192) is
 *  not pictographic and already narrow without an override. */
const NARROW_SYMBOL_CPS = new Set([0x263a, 0x26a0, 0x2713, 0x2717, 0x2610, 0x2611, 0x2612]);

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

const MARK_RE = /[\p{M}\p{Cf}]/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
/** Default-EMOJI-presentation code points render wide WITHOUT VS16 (❤
 *  is pictographic but text-presentation → narrow until VS16 joins). */
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
/** Genuinely wide East Asian ranges (CJK/Hangul/fullwidth) — used for the
 *  VS15 text-presentation exception: these stay 2 columns even with FE0E. */
const CJK_WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x2329, 0x232a],
  [0x1b000, 0x1b122],
  [0x20000, 0x3fffd],
];
/** Full keycap suffix: digit/#/* with optional FE0F plus U+20E3 (matched as a suffix, allowing any leading Prepend/zero-width prefix). */
const KEYCAP_RE = /[#*0-9]\uFE0F?\u{20E3}$/u;

function codePointWidth(cp: number): number {
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (NARROW_SYMBOL_CPS.has(cp)) return 1; // ⚠ ✓ ✗ and ballot boxes: narrow in most terminals
  const ch = String.fromCodePoint(cp);
  if (MARK_RE.test(ch)) return 0; // all Unicode marks (incl. U+1AB0+) are zero-width
  if (inRanges(cp, WIDE_RANGES) || EMOJI_PRESENTATION_RE.test(ch)) return 2; // incl. ✅ and modern emoji (U+1FAE0…)
  return 1;
}

/** Grapheme segmentation: ZWJ emoji, regional-indicator flags, and keycap
 *  sequences form single terminal graphemes, so width is measured per
 *  cluster. Intl.Segmenter ships in every Node the extension supports (the
 *  CI/test runner require Node ≥ 22); the per-code-point branch below is
 *  defensive-only for hypothetical segmenter-less hosts — its slightly
 *  coarser width is acceptable there, and it exists so width measurement can
 *  never crash. */
const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Terminal display width of a string, measured per grapheme cluster: ZWJ
 *  emoji (👨‍👩‍👧‍👦) and regional-indicator flags (🇺🇸) count as one cluster
 *  (2 columns when pictographic/flag); keycap sequences (base + U+20E3) also
 *  count 2; wide/fullwidth characters count 2; marks count 0. */
export function displayWidth(text: string): number {
  if (graphemeSegmenter) {
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      // Cluster-level rules: keycap sequences (base + FE0F + 20E3) render ~2
      // columns even when the base is a 1-column digit; a VS16 (U+FE0F) only
      // forces emoji presentation (2 columns) when the cluster also carries
      // an Extended_Pictographic base — a standalone selector keeps its
      // zero-width per ZERO_RANGES.
      if (KEYCAP_RE.test(segment) || (segment.includes("\u{FE0F}") && EMOJI_RE.test(segment))) {
        width += 2;
        continue;
      }
      if (segment.includes("\u{FE0E}")) {
        // VS15 forces text presentation: the base renders with its TEXT
        // width — 2 only for genuinely wide CJK-range bases, 1 for
        // text-presentation pictographs (⚡), 0 for marks. The base is the
        // widest visible code point (skipping the selector), so Prepend
        // characters (U+0600) do not hide a following CJK base.
        let textWidth = 0;
        for (const ch of segment) {
          const cp = ch.codePointAt(0)!;
          if (cp === 0xfe0e || inRanges(cp, ZERO_RANGES) || MARK_RE.test(ch)) continue;
          const cw = inRanges(cp, CJK_WIDE_RANGES) ? 2 : 1;
          if (cw > textWidth) textWidth = cw;
        }
        width += textWidth;
        continue;
      }
      // Cluster width from ALL code points (max): Prepend characters
      // (e.g. U+0600) form a grapheme with the following visible character,
      // so a first-code-point-only rule would report 0 columns.
      let clusterWidth = 0;
      for (const ch of segment) {
        const cw = codePointWidth(ch.codePointAt(0)!);
        if (cw > clusterWidth) clusterWidth = cw;
      }
      width += clusterWidth;
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
 *  boundaries; content is never discarded. Embedded CR/LF are hard line
 *  boundaries (each segment frames separately) and tabs normalize to two
 *  spaces; continuation lines align under the first line's text. A prefix
 *  that cannot leave room for content falls back to the continuation lead
 *  for every line, so wrapping always progresses. Exported for
 *  degenerate-path tests. */
export function wrapInto(lines: string[], text: string, firstPrefix: string, continuation: string): void {
  const hardLines = text.split(/\r\n|\r|\n/).map((s) => s.replace(/\t/g, "  "));
  let first = true;
  for (const segment of hardLines) {
    wrapSegment(lines, segment, first ? firstPrefix : continuation, continuation);
    first = false;
  }
}

function wrapSegment(lines: string[], text: string, firstPrefix: string, continuation: string): void {
  let rest = text;
  let first = true;
  for (;;) {
    const useFirst = first && displayWidth(firstPrefix) < INNER_WIDTH;
    const lead = useFirst ? firstPrefix : continuation;
    const leadWidth = displayWidth(lead);
    const room = INNER_WIDTH - leadWidth;
    const clusters = toClusters(rest);
    if (clusters.length === 0) {
      // Empty text: still emit the lead line so numbered/glyph prefixes never
      // vanish (e.g. an empty step description keeps its number and glyph).
      // Use lead (not raw firstPrefix) so an oversized prefix falls back to
      // the continuation, preserving the width contract.
      if (first) lines.push(framed(lead));
      return;
    }

    // Find the widest fitting cut (cluster index), measuring columns.
    let cut = 0;
    let lastSpace = -1;
    let acc = 0;
    let broke = false;
    for (let i = 0; i < clusters.length; i++) {
      const w = displayWidth(clusters[i]!);
      if (acc + w > room) {
        broke = true;
        break;
      }
      if (clusters[i] === " ") lastSpace = i;
      acc += w;
      cut = i + 1;
    }

    if (cut === 0) {
      // Nothing fits the room (room <= 0, or the first cluster is wider than
      // it): consume the first complete cluster, truncating the lead to
      // reserve display width for it, so no content is ever dropped and the
      // loop always progresses.
      const firstCluster = clusters[0]!;
      const leadRoom = Math.max(1, INNER_WIDTH - displayWidth(firstCluster));
      lines.push(framed(sliceToWidth(lead, Math.min(leadWidth, leadRoom)) + firstCluster));
      rest = clusters.slice(1).join("").trimStart();
      if (!rest) return;
      first = false;
      continue;
    }

    // Trim at the last word boundary ONLY when the fit loop broke early — a
    // whole-text fit must never be wrapped at its spaces.
    if (broke && lastSpace >= 0 && lastSpace < cut) cut = lastSpace + 1;
    lines.push(framed(lead + clusters.slice(0, cut).join("")));
    rest = clusters.slice(cut).join("").trimStart();
    if (!rest) return;
    first = false;
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
  // Render whenever a plan object exists — even an empty-todo plan (0/0
  // steps) renders sanely rather than hiding, matching the acceptance
  // contract. Only a wholly absent plan hides the widget.
  if (!state.plan) {
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

    // Compact grid: all steps as "N:glyph" pairs on as few lines as fit.
    const stepPairs: string[] = [];
    for (let i = 0; i < plan.todo.length; i++) {
      stepPairs.push(`${i + 1}:${stepGlyph(state, i)}`);
    }
    // Pack step pairs into lines that fit INNER_WIDTH.
    let grid = "";
    for (const pair of stepPairs) {
      const candidate = grid ? `${grid} ${pair}` : pair;
      if (displayWidth(candidate) > INNER_WIDTH) {
        lines.push(framed(grid));
        grid = pair;
      } else {
        grid = candidate;
      }
    }
    if (grid) lines.push(framed(grid));
    // One current-step description line (the "what am I working on now" answer).
    if (completed < total) {
      const desc = planStepDescription(plan.todo[completed]!);
      const blockedBy = getBlockedBy(state, completed);
      const annotation = blockedBy ? ` ⚠ blocked by #${blockedBy.join(", #")}` : "";
      wrapInto(lines, `→ ${completed + 1}: ${desc}${annotation}`, "", "   ");
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
