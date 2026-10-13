---
name: wai-learning
description: Recall and maintain useful project lessons through wai_index and wai_learn. Use after a confirmed user correction, a resolved non-obvious failure, a reusable project discovery, or evidence that a stored lesson is outdated.
license: MIT
---

# Learn lessons that improve future work

Before repeating an investigation, use relevant lessons already in context. If those
are insufficient, query `wai_index({topic:"learned", query:"..."})` using the subsystem
or source path. Avoid repeated lookups with unchanged input. Treat stored claims as leads and check
load-bearing assumptions against current code and the user's latest instructions.

Capture a lesson when it would change a future decision: an explicit user correction,
a confirmed root cause with a successful remedy, a non-obvious project constraint,
or an intentional project decision. Record its scope, the actionable conclusion, and
a source pointer. Skip obvious facts readily available in existing guidance and
combine observations about the same correction into one useful lesson. A failed attempt alone does not establish the cause or a universal
rule. Reviewer suggestions and `/wai-reflect` results are candidates to investigate;
do not automatically turn every suggestion into a fact with `--learn`.

Use `wai_learn({fact:"...", category:"...", source:"relative/path"})` for a confirmed
project claim. Use `kind:"decision"` only for an established intentional choice,
including its rationale and limits; reviewers give these entries special treatment.
Do not use decisions to suppress unresolved defects or dismiss later contrary evidence.
The source field points to evidence; it does not itself verify the claim.

For example, after inspecting a host adapter and its compatibility requirements:
"The adapter supports hosts without API X; gate X on its documented capability and
retain the legacy path for unsupported hosts." Link the actual adapter or contract.
Avoid context-free reminders such as "be careful with compatibility."

Inspect related entries before writing. Identical text, kind, category, and source
reuse the existing entry without renewing its age. Similar wording is not deduplicated
automatically: if a lesson is corrected, use `wai_learn({replace:"<entry ID>",
fact:"<corrected lesson>"})`; if it is no longer valid, use
`wai_learn({revoke:"<entry ID>"})`. Obtain the ID from `wai_index`; never guess it.
Replacement retains omitted metadata, so update the source when evidence changes.
Do not replace a lesson with a narrower claim that loses a still-valid constraint.

Use `wai_learn({stale:true})` when maintaining memory. Structural `verify:true` checks
references and does not establish behavior or renew freshness. `verify:true, deep:true`
uses the secondary model and costs tokens; use it when the claim warrants that work.
Reaffirm an unchanged claim only after establishing that it still holds, never just
to make it appear fresh. Saving a new claim starts its freshness window but is not
proof of verification. Check the operation result before saying it was remembered.

Keep secrets, copied logs, temporary status, unfinished hypotheses, and current task
goals out of durable lessons. Active outcomes and next actions belong in the Wai plan
and session context. Do not interrupt useful work to manufacture a lesson after every
turn, and do not claim learning improved performance until later reuse supports it.
Keep routine lookup/save success out of user-facing progress and completion reports
unless requested. Surface failed persistence or a material conflict with an existing
decision. Run reflection or deep verification for a concrete need, not on every task.

If repeated successful work reveals a substantial reusable procedure, propose a
focused project skill with its prerequisites, steps, failure cases, and evidence.
Keep short project facts in `wai_learn`; do not automatically rewrite packaged skills
or shared instructions from one incident. Continue the active task after capturing
a useful lesson; memory maintenance does not complete the user's requested outcome.
