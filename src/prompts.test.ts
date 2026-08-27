import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonResponse,
  salvageReviewFromMarkdown,
  salvageJudgeFromMarkdown,
  salvagePlanFromMarkdown,
  salvageSuggestFromMarkdown,
  salvageRecommendFromMarkdown,
  salvageTestFromMarkdown,
  salvageSecurityFromMarkdown,
  validateReviewResult,
  validateJudgeResult,
  validateConventionsResult,
  validateTestResult,
  validateSecurityResult,
  buildPlanPrompt,
  buildAdaptiveReviewPrompt,
  buildReviewUserContext,
  buildSuggestPrompt,
  buildScanPrompt,
  buildRecommendPrompt,
  buildTestPrompt,
  buildSecurityPrompt,
  buildJudgePrompt,
  buildExplainPrompt,
  buildVerifyPrompt,
  buildAdvisorPrompt,
  clearPromptCache,
} from "./prompts.js";

describe("parseJsonResponse", () => {
  it("parses plain JSON", () => {
    const result = parseJsonResponse('{"foo": "bar"}');
    assert.deepEqual(result, { foo: "bar" });
  });

  it("parses JSON inside markdown fence", () => {
    const result = parseJsonResponse('```json\n{"foo": "bar"}\n```');
    assert.deepEqual(result, { foo: "bar" });
  });

  it("parses the explicit markdown result JSON block", () => {
    const result = parseJsonResponse(`# Analysis
This is the reasoning.

## Result
\`\`\`json
{"foo": "bar"}
\`\`\``);
    assert.deepEqual(result, { foo: "bar" });
  });

  it("prefers the explicit result block over earlier valid JSON examples", () => {
    const result = parseJsonResponse(`Example:
\`\`\`json
{"foo": "example"}
\`\`\`

## Result
\`\`\`json
{"foo": "actual"}
\`\`\``);
    assert.deepEqual(result, { foo: "actual" });
  });

  it("parses JSON wrapped in prose", () => {
    const result = parseJsonResponse('Here is the result:\n{"foo": "bar"}\nHope that helps!');
    assert.deepEqual(result, { foo: "bar" });
  });

  it("parses largest balanced object when nested", () => {
    const result = parseJsonResponse('prefix {"outer": {"inner": 1}} suffix');
    assert.deepEqual(result, { outer: { inner: 1 } });
  });

  it("returns null for invalid input", () => {
    const result = parseJsonResponse("not json");
    assert.equal(result, null);
  });

  it("returns null for empty input", () => {
    const result = parseJsonResponse("");
    assert.equal(result, null);
  });

  it("unwraps common wrapper objects", () => {
    const result = parseJsonResponse('{ "response": "{ \\"foo\\": \\"bar\\" }" }');
    assert.deepEqual(result, { foo: "bar" });
  });

  it("unwraps wrapper containing markdown JSON", () => {
    const result = parseJsonResponse('{ "content": "```json\\n{ \\"foo\\": \\"bar\\" }\\n```" }');
    assert.deepEqual(result, { foo: "bar" });
  });
});

describe("salvageReviewFromMarkdown", () => {
  it("extracts pass verdict and suggestions from markdown", () => {
    const text = `# Review

Verdict: pass

- Add a comment
- Move to IDEs section`;
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
    assert.equal(result?.suggestions.length, 2);
    assert.equal(result?.consensus, false);
  });

  it("extracts blocked verdict from explicit line", () => {
    const text = "Verdict: blocked\n\n- Fix the crash";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "blocked");
    assert.equal(result?.suggestions.length, 1);
  });

  it("does not infer blocked from prose keyword", () => {
    const text = "The model discussed how the change could be blocked by policy, but no explicit verdict was given.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "needs-work");
  });

  it("detects an explicit step-complete statement for guarded auto-completion", () => {
    const text = "Verdict: pass\n\nThe current step is complete and all its files were reviewed.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
    assert.equal(result?.stepComplete, true);
  });

  it("does not infer stepComplete from negated or conditional prose", () => {
    const text = "Verdict: needs-work\n\nThe step is not complete yet; the parser still needs tests.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.stepComplete, undefined);
  });

  it("does not infer stepComplete from adjectival uses of the keyword", () => {
    const text = "Verdict: pass\n\nThe step is complete garbage and should be rewritten.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.stepComplete, undefined);
  });

  it("does not infer stepComplete from conditional or temporal framing", () => {
    const text = "Verdict: pass\n\nOnce the step is complete, run the tests and close the ticket.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.stepComplete, undefined);
  });

  it("detects an explicit stale-plan statement", () => {
    const text = "Verdict: pass\n\nThe plan is stale — the code no longer matches the plan's step two.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.planStale, true);
  });

  it("does not infer planStale from negated prose", () => {
    const text = "Verdict: pass\n\nThe plan is not stale; the implementation follows it exactly.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.planStale, undefined);
  });

  it("does not infer planStale from conditional advice", () => {
    const text = "Verdict: pass\n\nIf the plan no longer matches the code, run /wai-plan-update.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.planStale, undefined);
  });

  it("does not extract file names as suggestions", () => {
    const text = `## Review

**Overall: ✅ Looks good.**

### Files affected
- \`create-order.component.ts\`
- \`quotation.service.ts\`
- \`shipment.ts\` (bean constants)

The changes are well-structured and correct.`;
    const result = salvageReviewFromMarkdown(text);
    for (const s of result?.suggestions ?? []) {
      assert.ok(!/\.ts\b/.test(s), `File name leaked into suggestion: ${s}`);
    }
  });

  it("skips entire file-listing sections before extracting suggestions", () => {
    const text = `## Review

### Files affected
- create-order.component.ts — updated API calls
- quotation.service.ts — refactored methods

### Notes
- Consider adding error handling for the new API endpoints.`;
    const result = salvageReviewFromMarkdown(text);
    // The descriptive file bullets should be gone, but the real suggestion should remain.
    const suggestionText = (result?.suggestions ?? []).join(" ");
    assert.ok(/error handling/.test(suggestionText), `Real suggestion lost: ${suggestionText}`);
    assert.ok(!/create-order/.test(suggestionText), `File listing leaked: ${suggestionText}`);
  });

  it("does not infer blocked from 'broken' in positive prose", () => {
    const text =
      "## Review\n\n**Overall: ✅ Looks good.**\n\n- Keeps developers from thinking their own build config is broken.\n- Nothing is actually wrong here.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
  });

  it("does not infer blocked from 'cannot work' in prose", () => {
    const text = "The previous approach cannot work with older SDKs, but the new one handles it. Overall: looks good.";
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
  });

  it("does not extract diff descriptions as suggestions", () => {
    const text = `## Review

**Overall: ✅ Looks good.**

- **Old:** \`https://jb.gitlab.tiongnam.local/repo.git\`
- **New:** \`https://vpn-jb-gitlab.tiongnam.com/repo.git\`
- The URL change is correct and necessary.`;
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
    // The "Old:" and "New:" lines must not appear as suggestions.
    for (const s of result?.suggestions ?? []) {
      assert.ok(!/\b(old|new)\b\s*:/i.test(s), `Diff description leaked into suggestion: ${s}`);
    }
  });

  it("does not salvage a pass from a negated heading verdict", () => {
    const result = salvageReviewFromMarkdown("## Verdict: not approved\n\n- Fix the null check");
    assert.equal(result?.verdict, "needs-work");
  });

  it("does not salvage a pass from a 'cannot approve' heading", () => {
    const result = salvageReviewFromMarkdown("## Review: I cannot approve this change\n\n- Rework the parser");
    assert.notEqual(result?.verdict, "pass");
  });

  it("salvages needs-work from a request-changes heading", () => {
    const result = salvageReviewFromMarkdown("## Verdict: request changes\n\n- Add tests");
    assert.equal(result?.verdict, "needs-work");
  });

  it("still salvages pass from an approved heading", () => {
    const result = salvageReviewFromMarkdown("## Verdict: approved\n\n- Optional nit");
    assert.equal(result?.verdict, "pass");
  });

  it("does not infer pass from negated approval in prose", () => {
    const result = salvageReviewFromMarkdown("The change is not approved yet; several issues remain open.");
    assert.equal(result?.verdict, "needs-work");
  });
});

describe("salvageJudgeFromMarkdown", () => {
  it("extracts pass verdict and summary", () => {
    const text = "Verdict: pass\n\nSummary: All criteria are met.";
    const result = salvageJudgeFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
    assert.equal(result?.consensus, true);
    assert.match(result?.summary ?? "", /All criteria/);
  });

  it("extracts blocked verdict with suggestions", () => {
    const text = "Verdict: blocked\n\n- Missing tests\n- Step 2 not reviewed";
    const result = salvageJudgeFromMarkdown(text);
    assert.equal(result?.verdict, "blocked");
    assert.equal(result?.suggestions.length, 2);
    assert.equal(result?.consensus, false);
  });
});

describe("salvagePlanFromMarkdown", () => {
  it("extracts todo list and summary from markdown", () => {
    const text = `# Plan

Investigate and restore the build script.

1. Check existing scripts
2. Verify angular.json config
3. Add or restore build:hw

Acceptance criteria:
- build:hw runs successfully
- hw config exists`;
    const result = salvagePlanFromMarkdown(text, "fallback");
    assert.equal(result?.summary, "Plan");
    assert.equal(result?.todo.length, 3);
    assert.equal(result?.acceptanceCriteria.length, 2);
  });

  it("falls back to task when no list found", () => {
    const result = salvagePlanFromMarkdown("Just do the thing.", "fallback task");
    assert.equal(result?.todo.length, 1);
    assert.equal(result?.todo[0], "fallback task");
  });
});

describe("salvageSuggestFromMarkdown", () => {
  it("extracts approaches from headings", () => {
    const text = `## Option A
Use Provider A for speed.
- Pro: fast
- Con: expensive

## Option B
Use Provider B for cost.
- Pro: cheap`;
    const result = salvageSuggestFromMarkdown(text);
    assert.equal(result?.approaches.length, 2);
    assert.equal(result?.approaches[0].title, "Option A");
    assert.ok(result?.approaches[0].cons.length > 0);
  });

  it("falls back to single approach when no headings", () => {
    const result = salvageSuggestFromMarkdown("Try this.\n- It is simple\n- It is fast");
    assert.equal(result?.approaches.length, 1);
    assert.equal(result?.approaches[0].title, "Suggested approach");
    assert.equal(result?.approaches[0].pros.length, 2);
  });
});

describe("additional markdown salvage", () => {
  it("extracts a recommendation from markdown", () => {
    const result = salvageRecommendFromMarkdown(`## Next Step
Ship the parser change.

## Reasoning
It keeps the existing contract.

## Alternatives
- Make markdown primary
- Disable thinking`);
    assert.equal(result?.nextStep, "Ship the parser change.");
    assert.match(result?.reasoning ?? "", /contract/);
    assert.equal(result?.alternatives.length, 2);
  });

  it("extracts test findings from markdown", () => {
    const result = salvageTestFromMarkdown(`Verdict: needs-work

- Missing regression test for empty input

Missing tests:
- Add parser empty-input coverage`);
    assert.equal(result?.verdict, "needs-work");
    assert.ok(result!.findings.length > 0);
    assert.equal(result?.missingTests.length, 1);
  });

  it("extracts security findings from markdown", () => {
    const result = salvageSecurityFromMarkdown(`Verdict: needs-review

- Possible auth bypass in route guard`);
    assert.equal(result?.verdict, "needs-review");
    assert.equal(result?.findings[0]?.category, "auth");
  });
});

describe("lenient JSON repair (parseJsonResponse)", () => {
  it("repairs trailing commas", () => {
    const result = parseJsonResponse('{"a": 1, "b": 2,}');
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  it("repairs trailing comma in nested array", () => {
    const result = parseJsonResponse('{"items": [1, 2, 3,]}');
    assert.deepEqual(result, { items: [1, 2, 3] });
  });

  it("strips line comments", () => {
    const result = parseJsonResponse(`{
  // this is a comment
  "a": 1
}`);
    assert.deepEqual(result, { a: 1 });
  });

  it("strips block comments", () => {
    const result = parseJsonResponse(`{
  /* block comment */
  "a": 1
}`);
    assert.deepEqual(result, { a: 1 });
  });

  it("converts single-quoted strings to double quotes", () => {
    const result = parseJsonResponse("{'a': 'b'}");
    assert.deepEqual(result, { a: "b" });
  });

  it("quotes bare object keys", () => {
    const result = parseJsonResponse('{ verdict: "pass", issues: [] }');
    assert.deepEqual(result, { verdict: "pass", issues: [] });
  });

  it("repairs a fenced block with comments and trailing commas", () => {
    const result = parseJsonResponse(`## Result
\`\`\`json
{
  // verdict
  "verdict": "pass",
  "issues": [],
}
\`\`\``);
    assert.deepEqual(result, { verdict: "pass", issues: [] });
  });

  it("does not mangle valid JSON", () => {
    const result = parseJsonResponse('{"a": "// not a comment"}');
    assert.deepEqual(result, { a: "// not a comment" });
  });

  it("unescapes single quotes inside single-quoted strings", () => {
    const result = parseJsonResponse("{'a': 'it\\'s fine'}");
    assert.deepEqual(result, { a: "it's fine" });
  });
});

describe("richer markdown salvage", () => {
  it("parses review issues from a markdown table", () => {
    const text = `## Review

| File | Severity | Issue | Suggestion |
|------|----------|-------|------------|
| src/a.ts | high | null deref | add null check |
| src/b.ts:12 | low | naming | rename |`;
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.issues.length, 2);
    assert.equal(result?.issues[0]?.file, "src/a.ts");
    assert.equal(result?.issues[0]?.severity, "high");
    assert.match(result?.issues[0]?.issue ?? "", /null deref/);
    assert.match(result?.issues[0]?.suggestion ?? "", /null check/);
    assert.equal(result?.issues[1]?.file, "src/b.ts");
    assert.equal(result?.issues[1]?.line, 12);
  });

  it("detects explicit verdict line before keywords", () => {
    const result = salvageReviewFromMarkdown("**Verdict:** pass\n\n- minor nit");
    assert.equal(result?.verdict, "pass");
  });

  it("does not treat pass-through as a pass verdict", () => {
    const result = salvageReviewFromMarkdown("The value is pass-through and broken.");
    assert.equal(result?.verdict, "needs-work");
  });

  it("collects bullets under ### Issues as structured issues", () => {
    const text = `Verdict: needs-work

### Issues
- src/a.ts: missing error handling
- src/b.ts: typo in export

### Suggestions
- Consider a shared helper`;
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.issues.length, 2);
    assert.equal(result?.suggestions.length, 1);
    assert.match(result?.suggestions[0] ?? "", /shared helper/);
  });

  it("extracts severity-marker sections (### 🔴 Blocker:) as high issues", () => {
    const text = `## Review: Config changes

**Verdict: Request changes** — one file is fine, the other shouldn't be committed.

### 🔴 Blocker: \`application.properties\` — \`spring.profiles.active=dev\` uncommented

This forces the dev profile for every run. Revert it and activate the profile locally instead.

### 🟢 OK: \`application-dev.properties\` — ddl-auto update → none

Good safety change.`;
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "needs-work");
    assert.equal(result?.issues.length, 1);
    assert.equal(result?.issues[0]?.severity, "high");
    assert.equal(result?.issues[0]?.file, "application.properties");
    assert.match(result?.issues[0]?.issue ?? "", /spring\.profiles\.active=dev/);
    assert.match(result?.issues[0]?.issue ?? "", /forces the dev profile/);
  });

  it("maps 'Verdict: Approve' to pass and keeps numbered nits as suggestions", () => {
    const text = `**Verdict: Approve.** All claims verified against the actual codebase.

## Claim verification

| Claim | Result |
|---|---|
| No \`SearchDocument\` dependency | ✅ Confirmed |
| Matches \`SearchDocument.forwardRequest\` pattern | ✅ Identical body |

## Minor nits (non-blocking)

1. **Indentation** — new files use 4 spaces; project convention is tabs.
2. **\`throws TNException\`** on the controller method is now dead — could be dropped.`;
    const result = salvageReviewFromMarkdown(text);
    assert.equal(result?.verdict, "pass");
    assert.equal(result?.issues.length, 0);
    assert.equal(result?.suggestions.length, 2);
    assert.match(result?.suggestions[0] ?? "", /Indentation/);
    assert.match(result?.suggestions[1] ?? "", /throws TNException/);
  });

  it("treats an unparseable verdict heading as needs-work, not body-keyword pass", () => {
    const text = `## Review verdict: Claim does not match the working tree

The described change **does not exist** in this checkout. The diff was empty.

### 1. The claimed forwarding code is absent

- grep finds no match in \`CheckpointService\` or \`CheckpointController\`.
- The snippet was reverted, never saved, or written to a different working copy.

The good news is the existing implementation compiles and looks good otherwise.`;
    const result = salvageReviewFromMarkdown(text);
    // "looks good" in the body must NOT produce a pass — the verdict heading
    // itself could not be parsed, so the safe verdict wins.
    assert.equal(result?.verdict, "needs-work");
  });

  it("judge salvage reuses structured issues", () => {
    const text = `## Judgment: needs-work

| File | Severity | Issue |
|------|----------|-------|
| x.ts | high | crash |`;
    const result = salvageJudgeFromMarkdown(text);
    assert.equal(result?.verdict, "needs-work");
    assert.equal(result?.issues.length, 1);
    assert.equal(result?.issues[0]?.severity, "high");
  });

  it("parses test findings from a table", () => {
    const text = `Verdict: needs-work

| File | Category | Finding |
|------|----------|---------|
| src/a.ts | failing-test | does not assert throw |`;
    const result = salvageTestFromMarkdown(text);
    assert.equal(result?.findings.length, 1);
    assert.equal(result?.findings[0]?.file, "src/a.ts");
    assert.equal(result?.findings[0]?.category, "failing-test");
  });

  it("parses security findings from a table with category column", () => {
    const text = `Verdict: needs-review

| File | Severity | Category | Issue |
|------|----------|----------|-------|
| auth.ts | critical | auth | token not verified |`;
    const result = salvageSecurityFromMarkdown(text);
    assert.equal(result?.findings.length, 1);
    assert.equal(result?.findings[0]?.severity, "critical");
    assert.equal(result?.findings[0]?.category, "auth");
    assert.match(result?.findings[0]?.issue ?? "", /token not verified/);
  });

  it("validateReviewResult accepts table-salvaged issues", () => {
    const salvaged = salvageReviewFromMarkdown(`| File | Severity | Issue | Suggestion |
|------|----------|-------|------------|
| a.ts | high | x | fix it|`);
    assert.ok(validateReviewResult(salvaged!) !== null);
  });

  it("validateTestResult accepts table-salvaged findings", () => {
    const salvaged = salvageTestFromMarkdown(`Verdict: needs-work

| File | Category | Finding |
|------|----------|---------|
| a.ts | failing-test | x |`);
    assert.ok(validateTestResult(salvaged!) !== null);
  });

  it("validateSecurityResult accepts table-salvaged findings", () => {
    const salvaged = salvageSecurityFromMarkdown(`Verdict: needs-review

| File | Severity | Category | Issue |
|------|----------|----------|-------|
| a.ts | critical | auth | x |`);
    assert.ok(validateSecurityResult(salvaged!) !== null);
  });
});

describe("validateReviewResult", () => {
  it("derives consensus only from pass with no issues", () => {
    assert.equal(
      validateReviewResult({ verdict: "pass", issues: [], suggestions: [], consensus: false })?.consensus,
      true,
    );
    assert.equal(
      validateReviewResult({
        verdict: "pass",
        issues: [{ severity: "low", issue: "x", suggestion: "y" }],
        suggestions: [],
        consensus: true,
      })?.consensus,
      false,
    );
    assert.equal(
      validateReviewResult({ verdict: "needs-work", issues: [], suggestions: [], consensus: true })?.consensus,
      false,
    );
  });

  it("strips extra properties via cast", () => {
    const result = validateReviewResult({
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: false,
      extraField: "not allowed",
    });
    assert.ok(result);
    assert.equal("extraField" in result!, false);
  });

  it("passes through stepComplete and planStale", () => {
    const result = validateReviewResult({
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: false,
      stepComplete: true,
      planStale: false,
    });
    assert.ok(result);
    assert.equal(result?.stepComplete, true);
    assert.equal(result?.planStale, false);
  });

  it("normalizes null line values to undefined", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "high", line: null, issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, undefined);
  });

  it("normalizes string line values to undefined", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "medium", line: "submit method", issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, undefined);
  });

  it("preserves numeric line values", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "low", line: 97, issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, 97);
  });

  it("normalizes null file values to undefined", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "high", file: null, issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.file, undefined);
  });

  it("preserves string file values", () => {
    const result = validateReviewResult({
      verdict: "needs-work",
      issues: [{ severity: "high", file: "src/app.ts", issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.file, "src/app.ts");
  });
});

describe("validateJudgeResult", () => {
  it("normalizes non-numeric line values to undefined", () => {
    const result = validateJudgeResult({
      verdict: "needs-work",
      issues: [
        { severity: "high", line: null, issue: "x", suggestion: "y" },
        { severity: "medium", line: "submit method", issue: "x", suggestion: "y" },
      ],
      suggestions: [],
      consensus: false,
      summary: "test",
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, undefined);
    assert.equal(result!.issues[1]!.line, undefined);
  });

  it("preserves numeric line values", () => {
    const result = validateJudgeResult({
      verdict: "needs-work",
      issues: [{ severity: "low", line: 99, issue: "x", suggestion: "y" }],
      suggestions: [],
      consensus: false,
      summary: "test",
    });
    assert.ok(result);
    assert.equal(result!.issues[0]!.line, 99);
  });

  it("handles empty issues array", () => {
    const result = validateJudgeResult({
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      summary: "all good",
    });
    assert.ok(result);
    assert.equal(result!.issues.length, 0);
  });

  it("normalizes completedStepIds to sorted unique positive integers", () => {
    const result = validateJudgeResult({
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      summary: "all good",
      completedStepIds: [3, 1, 2, 1, -1, 0, NaN, Infinity, "x"],
    });
    assert.ok(result);
    assert.deepEqual(result!.completedStepIds, [1, 2, 3]);
  });

  it("normalizes incompleteStepIds the same way as completedStepIds", () => {
    const result = validateJudgeResult({
      verdict: "needs-work",
      issues: [],
      suggestions: [],
      consensus: false,
      summary: "step 3 is not done",
      incompleteStepIds: [4, 3, 3, -1, "x"],
    });
    assert.ok(result);
    assert.deepEqual(result!.incompleteStepIds, [3, 4]);
  });

  it("removes completedStepIds when no valid ids remain", () => {
    const result = validateJudgeResult({
      verdict: "pass",
      issues: [],
      suggestions: [],
      consensus: true,
      summary: "all good",
      completedStepIds: [-1, 0, NaN, "x"],
    });
    assert.ok(result);
    assert.equal(result!.completedStepIds, undefined);
  });
});

describe("prompt caching", () => {
  it("returns equal prompts for identical args", () => {
    const a = buildPlanPrompt("task", "conventions");
    const b = buildPlanPrompt("task", "conventions");
    assert.equal(a.system, b.system);
    assert.equal(a.user, b.user);
  });

  it("asks structured tools for markdown ending with fenced JSON", () => {
    const prompt = buildPlanPrompt("task", "conventions");
    assert.ok(prompt.system.includes("You may write brief Markdown analysis first."));
    assert.ok(prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("```json"));
    assert.ok(prompt.system.includes("Do not include any text after the closing JSON fence."));
  });

  it("uses parseable JSON examples in structured prompt fences", () => {
    const prompts = [
      buildPlanPrompt("task", "conventions"),
      buildAdaptiveReviewPrompt("desc", "diff", [], {}),
      buildScanPrompt(),
      buildSuggestPrompt("question", "conventions"),
      buildRecommendPrompt("situation", [], "conventions"),
      buildTestPrompt("desc", "diff", [], "tests ok", "conventions"),
      buildSecurityPrompt("desc", "diff", [], "conventions"),
      buildJudgePrompt("desc", {
        planTodo: [],
        acceptanceCriteria: [],
        reviewHistory: "history",
        conventions: "conventions",
      }),
    ];

    for (const prompt of prompts) {
      const fences = [...prompt.system.matchAll(/```json\s*([\s\S]*?)```/g)];
      assert.ok(fences.length > 0);
      for (const fence of fences) {
        assert.doesNotThrow(() => JSON.parse(fence[1].trim()));
      }
    }
  });

  it("returns distinct objects so mutations do not affect the cache", () => {
    const a = buildPlanPrompt("task", "conventions");
    a.system = "mutated";
    const b = buildPlanPrompt("task", "conventions");
    assert.notEqual(a.system, b.system);
    assert.ok(b.system.includes("pair programmer"));
  });

  it("returns different prompts for different args", () => {
    const a = buildPlanPrompt("task a", "conventions");
    const b = buildPlanPrompt("task b", "conventions");
    assert.notEqual(a.user, b.user);
  });

  it("caches review prompts with file contents", () => {
    const files = [{ file: "src/a.ts", content: "const x = 1;", mode: "full" as const }];
    const a = buildAdaptiveReviewPrompt("desc", "diff", files, {});
    const b = buildAdaptiveReviewPrompt("desc", "diff", files, {});
    assert.equal(a.user, b.user);
    assert.notStrictEqual(a, b);
  });

  it("renders priorRoundContext after memory and adds the anti-reflag rule", () => {
    const files = [{ file: "src/a.ts", content: "const x = 1;", mode: "full" as const }];
    const prior =
      "- src/name-input.ts — last review verdict: pass\n\n--- src/name-input.ts ---\nexport function NameInput() {}";
    const withPrior = buildAdaptiveReviewPrompt("desc", "diff", files, {
      memoryContext: "past issue in src/a.ts",
      priorRoundContext: prior,
      relatedContext: "--- src/other.ts ---\nother",
    });

    // Rendered between <memory> and <related_files>.
    const memoryIdx = withPrior.user.indexOf("<memory>");
    const priorIdx = withPrior.user.indexOf("<prior_review_context>");
    const relatedIdx = withPrior.user.indexOf("<related_files>");
    assert.ok(memoryIdx >= 0 && priorIdx > memoryIdx && relatedIdx > priorIdx);
    assert.ok(withPrior.user.includes("src/name-input.ts — last review verdict: pass"));

    // System rule guards against re-flagging earlier-round logic.
    assert.ok(
      withPrior.system.includes(
        "Prior-round context lists files reviewed earlier in this step that are NOT part of the current diff",
      ),
    );

    // Absent without the option.
    const withoutPrior = buildAdaptiveReviewPrompt("desc", "diff", files, {});
    assert.ok(!withoutPrior.user.includes("<prior_review_context>"));
    assert.ok(!withoutPrior.system.includes("Prior-round context lists files"));
  });

  it("caches static scan prompts", () => {
    const a = buildScanPrompt();
    const b = buildScanPrompt();
    assert.equal(a.system, b.system);
    assert.notStrictEqual(a, b);
  });

  it("does not cache prompts larger than the size cap", () => {
    const bigConventions = "x".repeat(60_000);
    const a = buildPlanPrompt("task", bigConventions);
    a.system = "mutated";
    const b = buildPlanPrompt("task", bigConventions);
    assert.notEqual(b.system, "mutated");
  });

  it("survives non-serializable arguments by bypassing the cache", () => {
    const circular: unknown[] = [];
    circular.push(circular);
    // buildRecommendPrompt expects string[]; cast the circular array to exercise the JSON.stringify guard.
    const a = buildRecommendPrompt("situation", circular as string[]);
    assert.ok(a.user.includes("situation"));
  });

  it("evicts oldest cached entries after maxEntries", () => {
    const first = buildPlanPrompt("task-0", "conventions");
    first.system = "mutated";
    for (let i = 1; i < 60; i++) {
      buildPlanPrompt(`task-${i}`, "conventions");
    }
    const recalled = buildPlanPrompt("task-0", "conventions");
    assert.notEqual(recalled.system, "mutated");
  });

  it("clears the cache via clearPromptCache", () => {
    const a = buildPlanPrompt("task", "conventions");
    a.system = "mutated";
    clearPromptCache();
    const b = buildPlanPrompt("task", "conventions");
    assert.notEqual(b.system, "mutated");
  });
});

describe("buildTestPrompt", () => {
  it("includes diff, test output, and conventions", () => {
    const prompt = buildTestPrompt(
      "added auth",
      "diff",
      [{ file: "src/auth.ts", content: "...", mode: "full" }],
      "1 passing",
      "naming: camelCase",
    );
    assert.ok(prompt.system.includes("test coverage"));
    assert.ok(prompt.user.includes("added auth"));
    assert.ok(prompt.user.includes("diff"));
    assert.ok(prompt.user.includes("1 passing"));
    assert.ok(prompt.user.includes("naming: camelCase"));
  });
});

describe("buildSecurityPrompt", () => {
  it("includes diff, file contents, and conventions", () => {
    const prompt = buildSecurityPrompt(
      "auth changes",
      "diff",
      [{ file: "src/auth.ts", content: "...", mode: "full" }],
      "naming: camelCase",
    );
    assert.ok(prompt.system.includes("security audit"));
    assert.ok(prompt.user.includes("auth changes"));
    assert.ok(prompt.user.includes("diff"));
    assert.ok(prompt.user.includes("src/auth.ts"));
    assert.ok(prompt.user.includes("naming: camelCase"));
  });
});

describe("validateTestResult", () => {
  it("accepts a valid test result", () => {
    const result = validateTestResult({
      verdict: "needs-work",
      findings: [
        { severity: "high", file: "src/a.ts", line: 5, issue: "x", suggestion: "y", category: "missing-test" },
      ],
      missingTests: [{ file: "src/a.ts", reason: "no coverage" }],
      summary: "needs tests",
    });
    assert.ok(result);
    assert.equal(result!.verdict, "needs-work");
    assert.equal(result!.findings[0]!.line, 5);
  });

  it("normalizes null file/line/category values", () => {
    const result = validateTestResult({
      verdict: "pass",
      findings: [{ severity: "low", file: null, line: null, issue: "x", suggestion: "y", category: null }],
      missingTests: [{ file: null, reason: "general" }],
      summary: "ok",
    });
    assert.ok(result);
    assert.equal(result!.findings[0]!.file, undefined);
    assert.equal(result!.findings[0]!.line, undefined);
    assert.equal(result!.findings[0]!.category, undefined);
    assert.equal(result!.missingTests[0]!.file, undefined);
  });

  it("rejects malformed data", () => {
    const result = validateTestResult("not an object");
    assert.equal(result, null);
  });
});

describe("validateSecurityResult", () => {
  it("accepts a valid security result", () => {
    const result = validateSecurityResult({
      verdict: "needs-review",
      findings: [
        { severity: "critical", file: "src/auth.ts", line: 10, issue: "x", suggestion: "y", category: "auth" },
      ],
      summary: "audit",
    });
    assert.ok(result);
    assert.equal(result!.verdict, "needs-review");
    assert.equal(result!.findings[0]!.severity, "critical");
  });

  it("normalizes null file/line values", () => {
    const result = validateSecurityResult({
      verdict: "pass",
      findings: [{ severity: "low", file: null, line: null, issue: "x", suggestion: "y", category: "other" }],
      summary: "ok",
    });
    assert.ok(result);
    assert.equal(result!.findings[0]!.file, undefined);
    assert.equal(result!.findings[0]!.line, undefined);
  });

  it("rejects malformed data", () => {
    const result = validateSecurityResult("not an object");
    assert.equal(result, null);
  });
});

describe("validateConventionsResult", () => {
  it("preserves incoming generatedAt", () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const result = validateConventionsResult({
      naming: "camelCase",
      structure: "src/",
      patterns: [],
      stack: "ts",
      entryPoints: ["src/index.ts"],
      scripts: [],
      generatedAt: ts,
    });
    assert.equal(result?.generatedAt, ts);
  });

  it("sets generatedAt when missing", () => {
    const result = validateConventionsResult({
      naming: "camelCase",
      structure: "src/",
      patterns: [],
      stack: "ts",
      entryPoints: ["src/index.ts"],
      scripts: [],
    });
    assert.ok(result);
    assert.ok(typeof result!.generatedAt === "string");
  });
});

describe("native JSON prompt instruction", () => {
  it("plan prompt keeps fenced JSON instruction by default", () => {
    const prompt = buildPlanPrompt("task", "conventions");
    assert.ok(prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("```json"));
    assert.ok(!prompt.system.includes("Return only valid JSON"));
  });

  it("review prompt uses raw JSON instruction when nativeJson is true", () => {
    const prompt = buildAdaptiveReviewPrompt("desc", "diff", [], { nativeJson: true });
    assert.ok(!prompt.system.includes("## Result"));
    assert.ok(!prompt.system.includes("```json"));
    assert.ok(prompt.system.includes("Return only valid JSON"));
  });

  it("review prompt keeps fenced JSON instruction when nativeJson is false", () => {
    const prompt = buildAdaptiveReviewPrompt("desc", "diff", [], { nativeJson: false });
    assert.ok(prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("```json"));
    assert.ok(!prompt.system.includes("Return only valid JSON"));
  });

  it("instructs guarded stepComplete in the plan rules when a current step is shown", () => {
    const prompt = buildAdaptiveReviewPrompt("desc", "diff", [], { currentStep: "step 1" });
    assert.ok(prompt.system.includes("ONLY when the current plan step's work is genuinely finished"));
  });

  it("instructs stepComplete false when no current step is shown", () => {
    const prompt = buildAdaptiveReviewPrompt("desc", "diff", [], {});
    assert.ok(prompt.system.includes('Set "planStale" to false, "stepComplete" to false'));
  });

  it("scan prompt uses raw JSON instruction when nativeJson is true", () => {
    const prompt = buildScanPrompt(true);
    assert.ok(!prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("Return only valid JSON"));
  });

  it("scan prompt keeps fenced JSON instruction by default", () => {
    const prompt = buildScanPrompt();
    assert.ok(prompt.system.includes("## Result"));
    assert.ok(!prompt.system.includes("Return only valid JSON"));
  });

  it("suggest prompt uses raw JSON instruction when nativeJson is true", () => {
    const prompt = buildSuggestPrompt("question", "conventions", true);
    assert.ok(!prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("Return only valid JSON"));
  });

  it("recommend prompt uses raw JSON instruction when nativeJson is true", () => {
    const prompt = buildRecommendPrompt("situation", [], "conventions", true);
    assert.ok(!prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("Return only valid JSON"));
  });

  it("test prompt uses raw JSON instruction when nativeJson is true", () => {
    const prompt = buildTestPrompt("desc", "diff", [], "tests ok", "conventions", true);
    assert.ok(!prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("Return only valid JSON"));
  });

  it("security prompt uses raw JSON instruction when nativeJson is true", () => {
    const prompt = buildSecurityPrompt("desc", "diff", [], "conventions", true);
    assert.ok(!prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("Return only valid JSON"));
  });

  it("judge prompt uses raw JSON instruction when nativeJson is true", () => {
    const prompt = buildJudgePrompt("desc", {
      planTodo: [],
      acceptanceCriteria: [],
      reviewHistory: "history",
      conventions: "conventions",
      memoryContext: "",
      nativeJson: true,
    });
    assert.ok(!prompt.system.includes("## Result"));
    assert.ok(prompt.system.includes("Return only valid JSON"));
  });

  it("suggest prompt includes external docs when provided", () => {
    const docs = '<external_docs>\n<doc_source name="react">docs</doc_source>\n</external_docs>';
    const prompt = buildSuggestPrompt("question", "conventions", false, docs);
    assert.ok(prompt.user.includes("<external_docs>"));
    assert.ok(prompt.user.includes('<doc_source name="react">'));
  });

  it("recommend prompt includes external docs when provided", () => {
    const docs = '<external_docs>\n<web_search query="q">results</web_search>\n</external_docs>';
    const prompt = buildRecommendPrompt("situation", [], "conventions", false, docs);
    assert.ok(prompt.user.includes("<external_docs>"));
    assert.ok(prompt.user.includes('<web_search query="q">'));
  });
});

describe("prompt structure contract", () => {
  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  const builders = {
    plan: () => buildPlanPrompt("task", "conventions", "snapshot"),
    review: () => buildAdaptiveReviewPrompt("desc", "diff", []),
    suggest: () => buildSuggestPrompt("question", "conventions"),
    recommend: () => buildRecommendPrompt("situation", [], "conventions"),
    judge: () =>
      buildJudgePrompt("desc", {
        planTodo: [],
        acceptanceCriteria: [],
        reviewHistory: "",
        conventions: "conventions",
        memoryContext: "",
      }),
    scan: () => buildScanPrompt(),
    test: () => buildTestPrompt("desc", "diff", [], "ok", "conventions"),
    security: () => buildSecurityPrompt("desc", "diff", [], "conventions"),
    explain: () => buildExplainPrompt("target", "context", "conventions"),
  };

  it("every builder system prompt starts with the shared persona prefix", () => {
    for (const [name, build] of Object.entries(builders)) {
      const { system } = build();
      assert.ok(
        system.startsWith("You are a senior pair programmer"),
        `${name} system should start with persona prefix`,
      );
    }
  });

  it("review prompt includes the review rubric and evidence rules", () => {
    const { system } = builders.review();
    assert.ok(system.includes("Review rubric"), "review system should include REVIEW_RUBRIC");
    assert.ok(system.includes("EVIDENCE REQUIREMENTS"), "review system should include EVIDENCE_RULES");
  });

  it("plan prompt includes the evidence rules", () => {
    const { system } = builders.plan();
    assert.ok(system.includes("EVIDENCE REQUIREMENTS"), "plan system should include EVIDENCE_RULES");
  });

  it("review prompt has no duplicate key block markers", () => {
    const { system, user } = builders.review();
    const combined = `${system}\n${user}`;
    assert.equal(countOccurrences(combined, "EVIDENCE REQUIREMENTS"), 1, "EVIDENCE REQUIREMENTS should appear once");
    assert.equal(countOccurrences(combined, "Review rubric"), 1, "Review rubric should appear once");
    assert.equal(countOccurrences(combined, "## Result"), 1, "## Result should appear once");
  });
});

describe("buildReviewUserContext (review block assembly)", () => {
  const base = {
    description: "fix the bug",
    diff: "--- a.ts\n+++ b.ts\n@@",
    fileContents: [] as Array<{ file: string; content: string; mode: "full" | "outline" }>,
  };

  it("always wraps the diff and includes the description", () => {
    const user = buildReviewUserContext(base);
    assert.ok(user.includes("fix the bug"), "description should be present");
    assert.ok(user.includes("<diff>"), "diff open tag expected");
    assert.ok(user.includes("</diff>"), "diff close tag expected");
    assert.ok(user.includes(base.diff), "diff content expected");
  });

  it("includes each optional block when provided", () => {
    const user = buildReviewUserContext({
      ...base,
      vcs: "git",
      criteria: "must handle null",
      currentStep: "step 1",
      sessionContext: "prior context",
      conventionsText: "use camelCase",
      preReviewOutput: "lint clean",
      memoryContext: "past issue",
      truncated: true,
      droppedFiles: ["big.ts"],
      budgetNote: "budget note",
    });
    assert.ok(user.includes("Version control: git"));
    assert.ok(user.includes("<acceptance_criteria>"));
    assert.ok(user.includes("Current plan step being reviewed:"));
    assert.ok(user.includes("<session_context>"));
    assert.ok(user.includes("<project_conventions>"));
    assert.ok(user.includes("<pre_review_output>"));
    assert.ok(user.includes("<memory>"));
    assert.ok(user.includes("truncated because it was too large"));
    assert.ok(user.includes("omitted due to token budget: big.ts"));
    assert.ok(user.includes("budget note"));
  });

  it("omits optional blocks when not provided", () => {
    const user = buildReviewUserContext(base);
    assert.ok(!user.includes("Version control:"));
    assert.ok(!user.includes("<acceptance_criteria>"));
    assert.ok(!user.includes("Current plan step being reviewed:"));
    assert.ok(!user.includes("<session_context>"));
    assert.ok(!user.includes("<project_conventions>"));
    assert.ok(!user.includes("<pre_review_output>"));
    assert.ok(!user.includes("<memory>"));
    assert.ok(!user.includes("omitted due to token budget"));
  });

  it("includes full file contents when provided", () => {
    const user = buildReviewUserContext({
      ...base,
      fileContents: [{ file: "src/a.ts", content: "const x = 1;", mode: "full" }],
    });
    assert.ok(user.includes("<file_contents>"));
    assert.ok(user.includes("src/a.ts"));
    assert.ok(user.includes("const x = 1;"));
  });

  it("includes the focus-files hint when provided and omits it otherwise", () => {
    const withFocus = buildReviewUserContext({ ...base, focusFiles: ["src/a.ts", "src/b.ts"] });
    assert.ok(withFocus.includes("<focus_files>"));
    assert.ok(withFocus.includes("src/a.ts, src/b.ts"));

    const without = buildReviewUserContext(base);
    assert.ok(!without.includes("<focus_files>"));
  });
});

describe("per-action instructions (user_instructions block)", () => {
  const INSTRUCTIONS = "# Team rules\n\n- always run typecheck before review\n";

  it("renders the instructions block in the plan system prompt with contract precedence", () => {
    const { system } = buildPlanPrompt("task", undefined, undefined, INSTRUCTIONS);
    assert.ok(system.includes("<user_instructions>"));
    assert.ok(system.includes("# Team rules"));
    assert.ok(system.includes("contract wins"), "framing rule should state contract precedence");
    // The output contract must come after the instructions block.
    assert.ok(system.indexOf("</user_instructions>") < system.indexOf("## Result"));
  });

  it("leaves the prompt unchanged when no instructions are provided", () => {
    const plain = buildPlanPrompt("task");
    const withEmpty = buildPlanPrompt("task", undefined, undefined, "");
    assert.equal(plain.system, withEmpty.system);
    assert.equal(plain.user, withEmpty.user);
    assert.ok(!plain.system.includes("<user_instructions>"));
  });

  it("injects instructions into the review system prompt via options", () => {
    const { system } = buildAdaptiveReviewPrompt("description", "diff", [], { instructionsText: INSTRUCTIONS });
    assert.ok(system.includes("<user_instructions>"));
    assert.ok(system.includes("# Team rules"));
  });

  it("injects instructions into non-JSON-contract prompts (explain, verify)", () => {
    const explained = buildExplainPrompt("target", undefined, undefined, undefined, undefined, "", INSTRUCTIONS);
    assert.ok(explained.system.includes("<user_instructions>"));
    const verified = buildVerifyPrompt("ctx", "result", "review", INSTRUCTIONS);
    assert.ok(verified.system.includes("<user_instructions>"));
    assert.ok(verified.system.includes("contract wins"));
  });

  it("includes instruction content in the memoization key", () => {
    try {
      clearPromptCache();
      const a = buildPlanPrompt("task", undefined, undefined, "rules A");
      const b = buildPlanPrompt("task", undefined, undefined, "rules A");
      const c = buildPlanPrompt("task", undefined, undefined, "rules B");
      // Same args → cached result (identical output); different instructions → different key.
      assert.equal(a.system, b.system);
      assert.notEqual(a.system, c.system);
      assert.ok(a.system.includes("rules A"));
      assert.ok(c.system.includes("rules B"));
    } finally {
      clearPromptCache();
    }
  });
});

describe("buildAdvisorPrompt (pair-programming advisor)", () => {
  it("is plain text with no JSON output contract", () => {
    const { system, user } = buildAdvisorPrompt("should I use a Map here?");
    assert.ok(system.includes("pair-programming advisor"));
    assert.ok(system.includes("state a clear recommendation"));
    assert.ok(!system.includes("## Result"), "no markdown JSON contract");
    assert.ok(!system.includes("JSON schema"), "no schema block");
    assert.ok(!system.includes("```json"), "no JSON fence");
    assert.ok(user.includes("should I use a Map here?"));
  });

  it("includes conventions and relevant files when provided", () => {
    const { user } = buildAdvisorPrompt("where should this live?", "Stack: node", [
      { file: "src/x.ts", content: "export const x = 1", mode: "outline" },
    ]);
    assert.ok(user.includes("<project_conventions>"));
    assert.ok(user.includes("<relevant_files>"));
    assert.ok(user.includes("src/x.ts"));
  });

  it("injects advisor instructions with the contract-wins framing", () => {
    const { system } = buildAdvisorPrompt("question", undefined, undefined, "ALWAYS USE RECORD");
    assert.ok(system.includes("<user_instructions>"));
    assert.ok(system.includes("ALWAYS USE RECORD"));
    assert.ok(system.includes("contract wins"));
  });
});
