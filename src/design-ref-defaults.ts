import { estimateTokens } from "./token-budget.js";
import { addDesignRule, clearDesignRules, peekDesignRules } from "./design-ref.js";

export const DEFAULT_RULES_SOURCE = "emilkowalski/skills (MIT)";

/** Reviewer rules distilled from Emil Kowalski's design-engineering skills
 *  (vendored under design-refs/, MIT licensed). Seeded into the per-project
 *  design-rule store so UI reviews have a sane baseline out of the box. */
export const DEFAULT_DESIGN_RULES: string[] = [
  "Never use ease-in on UI; entering/exiting elements use ease-out, on-screen movement ease-in-out, hover/color ease, constant motion linear.",
  "UI animations stay under 300ms (buttons 100-160ms, tooltips 125-200ms, dropdowns 150-250ms, modals/drawers 200-500ms).",
  "Only animate transform and opacity; animating width/height/margin/padding/top/left triggers layout and paint.",
  "Never scale from 0; enter from scale(0.9-0.97) + opacity 0.",
  "Popovers/menus scale from their trigger's transform-origin, not center; modals are exempt.",
  "Pressable elements give :active press feedback via transform: scale(0.95-0.98) over ~160ms ease-out.",
  "Never animate keyboard-initiated or 100+/day actions (command palette, shortcuts); reduce motion for tens/day interactions.",
  "Respect prefers-reduced-motion: keep opacity/color fades, drop transform-based movement.",
  "Gate hover motion behind @media (hover: hover) and (pointer: fine) so touch taps don't fire false hovers.",
  "Prefer CSS transitions over keyframes for rapidly re-triggered UI (toasts, toggles) — transitions are interruptible, keyframes restart from zero.",
  'Use springs for drag-with-momentum, interruptible gestures, and "alive" elements; keep bounce subtle (0.1-0.3).',
  "Stagger group entrances 30-80ms per item; never block interaction while a stagger plays.",
  "Framer Motion x/y/scale shorthands run on the main thread; use full transform strings for hardware acceleration.",
  "Prefer CSS/WAAPI animations over rAF-driven JS for predetermined motion — they run off the main thread.",
  "Set transform directly on the animated element, not via a CSS variable on the parent (recalcs all children).",
  "Prefer translate percentages over hardcoded px so motion adapts to element size.",
  "Drag dismissal uses velocity, not just distance thresholds (flick > ~0.11 px/ms dismisses).",
  "Boundary over-drag uses rising resistance (friction), never hard stops.",
  'Motion must serve spatial consistency, state indication, explanation, or feedback — "looks cool" on a frequent element is not valid.',
  "Match motion personality to the component: playful can bounce, professional dashboards stay crisp and fast.",
  "Mask imperfect crossfades with a subtle filter: blur(2px) during the transition (keep blur < 20px).",
  "Semi-transparent shadows over solid 1px borders for elevation.",
];

/** 1-based indexes into DEFAULT_DESIGN_RULES of the most load-bearing rules
 *  surfaced to the main (writer) agent. */
const WRITER_RULE_INDEXES = [1, 2, 3, 4, 5, 7, 8, 9, 13, 19];

const WRITER_GUIDANCE_HINT = "Call the wai_design_ref tool for full design guidance.";

/** Compact design guidance for the main agent writing UI code: the most
 *  load-bearing rules plus a pointer to the wai_design_ref tool. */
export function formatWriterDesignGuidance(cwd: string, maxTokens: number): string {
  try {
    if (maxTokens <= 0) return "";
    const rules = WRITER_RULE_INDEXES.map((i) => DEFAULT_DESIGN_RULES[i - 1]).filter(
      (r): r is string => typeof r === "string",
    );
    if (rules.length === 0) return "";
    const lines: string[] = [];
    let used = estimateTokens(WRITER_GUIDANCE_HINT);
    for (const rule of rules) {
      const line = `- ${rule}`;
      const cost = estimateTokens(line);
      if (used + cost > maxTokens) break;
      lines.push(line);
      used += cost;
    }
    if (lines.length === 0) return "";
    return `${lines.join("\n")}\n${WRITER_GUIDANCE_HINT}`;
  } catch {
    return "";
  }
}

/** Seed the store with the distilled defaults, but only when the user has no
 *  rules of their own yet. Returns whether it seeded. Never throws. */
export function seedDefaultDesignRules(cwd: string): boolean {
  try {
    if (peekDesignRules(cwd).length > 0) return false;
    for (const rule of DEFAULT_DESIGN_RULES) {
      addDesignRule(cwd, rule, DEFAULT_RULES_SOURCE);
    }
    return true;
  } catch {
    return false;
  }
}

/** Replace the store with the distilled defaults (explicit user action). */
export function resetDesignRulesToDefaults(cwd: string): number {
  clearDesignRules(cwd);
  for (const rule of DEFAULT_DESIGN_RULES) {
    addDesignRule(cwd, rule, DEFAULT_RULES_SOURCE);
  }
  return DEFAULT_DESIGN_RULES.length;
}
