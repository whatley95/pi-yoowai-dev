# Audit and opportunities

For requested interface/motion audits, map the framework, UI surfaces, existing
motion/tokens, product decisions, and frequently used interactions. Inspect source
and the running interface when available. Declare whether the scan is sampled or
complete; do not promise whole-project coverage from a few files.

Evaluate purpose/frequency, timing, origin/physicality, interruption, rendering and
lifecycle performance, accessibility, token cohesion, and genuinely missing feedback.
Verify each finding against its actual location. Keep deliberate tradeoffs and
equivalent implementations; separate improvements from defects.

For animation opportunities, inspect press-feedback gaps, jarring state changes,
anchored overlays, occasional group entrances, gesture handoffs, and rare success or
onboarding moments. Suggest motion only when it helps the user's task; unchanged
frequent navigation or information-dense data can be the correct outcome.

Prioritize a small set by impact and effort, with location, evidence, intended outcome,
and verification. Do not manufacture a fixed number of findings or opportunities.

If the user requested implementation, continue within that authorization. If the
request is analysis only, report findings without editing source. Use the active Wai
plan for agreed outcomes instead of creating a second tracker. Record preservation
criteria, dependencies, and completion checks; defer uncertain implementation details
until their relevant source has been inspected.

Use Git or SVN evidence according to the checkout. No worktree or subagent is required;
use delegation only when available and authorized. Reconcile a plan against positive
evidence of a changed decision, not against every partial diff or absent future step.
