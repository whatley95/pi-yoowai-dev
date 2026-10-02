# Wai workflows in Pi codemode

Pi 1.0 exposes the `wai` namespace. Read `describeNamespace("wai")` for detailed
instructions, or call `wai_index({ topic: "guidance" })` without codemode. Essential
scope, completion, evidence, and commit rules remain in the visible tool guidance.
Older hosts retain the full visible instructions and the same tool names.

## Retrieve only relevant project knowledge

```js
const result = await tools.wai_index({
  topic: "learned",
  files: ["src/auth/"],
  query: "refresh",
  limit: 8,
});
text({
  facts: (result.learned ?? []).map((fact) => ({
    fact: fact.fact,
    source: fact.source,
    lastVerifiedAt: fact.lastVerifiedAt ?? fact.timestamp,
  })),
  selection: result.selection,
});
```

Use `topic: "memory"` and `memoryEntries` for past issues with file attribution.
Use `topic: "index"` and `index.files` for symbols, imports, and dependents.
`files`, `query`, and `limit` select knowledge; they do not change stored knowledge
or limit review coverage. Selection counts disclose omitted results. `limit`
bounds memory files, learned facts, and index files and total symbols (1–100).
Retained learned facts may be stale; verify them against current code. Do not
store full source, image data, or complete indexes with codemode `store()`.

## Inspect a review without parsing its report

```js
const result = await tools.wai({ review: "Describe the completed change and checks." });
text({
  error: result.error,
  verdict: result.review?.verdict,
  inconclusive: result.review?.inconclusive,
  scopeLimited: result.review?.scopeLimited,
  droppedFiles: result.review?.droppedFiles,
  recovery: result.recovery,
  workflow: result.workflow,
});
```

Recovery reasons come from local capture and validation signals. Follow
`recovery.nextAction` before retrying; unresolved errors need diagnosis, not an
unchanged retry loop or an automatic reduction in thinking depth. The workflow
snapshot records actual tracker progress after outcome application. It does not
prove acceptance criteria, and review can already have advanced the current step.
Obtain complete unscoped review coverage before certification. Never combine a
review and `done` in parallel or advance merely because the verdict says pass.

## Generate a requested design reference and ask wai to critique it

This optional workflow requires Pi 1.0 codemode models support, an authenticated
image model, and a wai vision model that accepts image input on the SDK backend.
Image generation uses Pi's session authentication and cost accounting. The wai
critique uses the configured vision model and wai budget. No image is generated
automatically during review, scan, or planning.

```js
// @options: {"timeout_ms": 300000}
const available = await models.getAvailableOfType("image");
if (!available.length) return "Configure an image model before generating a reference.";
const generated = await models.generateImages(available[0], {
  input: [{ type: "text", text: "Generate the design reference requested by the user." }],
});
if (generated.stopReason !== "stop") return generated.errorMessage ?? "Image generation did not complete.";
const reference = generated.output.find((block) => block.type === "image");
if (!reference) return "The image model returned no image.";
image(reference);
const critique = await tools.wai_vision({
  image: reference,
  question: "Assess hierarchy, readability, accessibility, and consistency with the supplied design rules.",
  context: "This is a proposed reference, not a screenshot of the implemented UI.",
});
text({ error: critique.error, analysis: critique.vision });
```

Pass the image block directly; do not print or store its base64 data. Inline
images have the same 5 MB decoded cap as image files and accept PNG, JPEG, GIF,
or WebP. Choose exactly one `image` or `path`. Existing image/PDF path calls and
the `/wai-vision` command continue working. A reference critique does not certify
the implemented UI; inspect or capture the real UI separately.

The new contracts and workflows have deterministic compatibility tests. They do
not establish live-model accuracy equivalence or a measured review speedup.

## Native review context and memory pressure

When a wai tool runs on a host with `ctx.executeTool()`, its secondary context
requests use Pi's callable `read` and `grep` tools. Pi can apply its tool hooks,
permissions, cancellation, and nested-call tracing to those operations. Wai
validates project paths and search candidates, bounds exact-path search batches
and outputs, and supplies JSON paging requests. The reviewer prompt advertises
only callable reads/searches; Pi's default active tool set may omit `grep`.
A host denial or disabled tool
requires correcting the host configuration; it never triggers a local-reader
fallback. Slash commands, automatic actions, and older hosts use the local
reader. Repeated native reads still execute Pi's policy hooks; when their
approved bounded output is identical, the model prompt references the earlier
entry instead of repeating the source. Model-generated commands keep wai's
existing allowlist.

Main-agent memory injection uses Pi's estimated context usage when available.
Optional facts, advisor notes, design rules, and conventions shrink above 75%
utilization and are omitted at 95%. Plan/workflow/language/VCS guidance and
selected fresh decisions keep priority within `contextInjectMaxTokens`. Unknown
usage after compaction retains the configured behavior. This changes optional
main-agent context only; it does not reduce review evidence, advance the plan,
or trigger compaction.
