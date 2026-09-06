import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectIndex, saveProjectIndex } from "./project-index.js";
import {
  recordLearnedFact,
  loadLearnedFacts,
  findLearnedFacts,
  listStaleFacts,
  getFactFreshness,
  isFactFresh,
  markFactVerified,
  reaffirmFact,
  formatLearnedFactsWithFreshness,
  FRESHNESS_BUDGET_MS,
  formatLearnedFacts,
  clearLearnedFacts,
  verifyLearnedFacts,
  applyVerifiedRenewals,
  formatVerificationReport,
  verifyLearnedFactsDeep,
} from "./wai-learn.js";

describe("wai-learn", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-learn-test-"));
  });

  it("sets the verification stamp at creation", () => {
    const entry = recordLearnedFact(cwd, "Use camelCase.");
    assert.equal(entry.lastVerifiedAt, entry.timestamp, "a fresh record starts verified");
    assert.ok(isFactFresh(entry), "new records are fresh");
  });

  it("stays fresh before the budget and stale at/after it", () => {
    const now = new Date();
    const past = (ageMs: number) => new Date(now.getTime() - ageMs).toISOString();
    // Decision: exactly at budget (90d) → stale; 1 ms before → fresh.
    // One fixed `now` drives both stamps and the evaluation, so the
    // 1-ms boundary cannot flip on wall-clock delay.
    const almost = {
      fact: "d",
      kind: "decision" as const,
      timestamp: past(FRESHNESS_BUDGET_MS.decision - 1),
      lastVerifiedAt: past(FRESHNESS_BUDGET_MS.decision - 1),
    };
    const at = {
      fact: "d",
      kind: "decision" as const,
      timestamp: past(FRESHNESS_BUDGET_MS.decision),
      lastVerifiedAt: past(FRESHNESS_BUDGET_MS.decision),
    };
    assert.equal(isFactFresh(almost, now), true);
    assert.equal(isFactFresh(at, now), false);
    const freshness = getFactFreshness(at, now);
    assert.ok(freshness.staleSince, "stale entries expose when they became stale");
    assert.ok(Date.parse(freshness.staleSince!) <= now.getTime());
  });

  it("applies per-kind budgets and overrides", () => {
    const D = 24 * 60 * 60 * 1000;
    const past = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
    // Plain fact 200 days old: fresh under 365d budget, stale under a 100d override.
    const fact = { fact: "f", timestamp: past(200 * D), lastVerifiedAt: past(200 * D) };
    assert.equal(isFactFresh(fact), true, "200d is fresh under the 365d fact budget");
    assert.equal(isFactFresh(fact, new Date()), true);
    const overridden = getFactFreshness(fact, new Date(), { fact: 100 * D });
    assert.equal(overridden.stale, true, "overrides affect expiry");
    // Decision 60 days old: fresh (90d budget) but older than a 30d override.
    const decision = {
      fact: "d",
      kind: "decision" as const,
      timestamp: past(60 * D),
      lastVerifiedAt: past(60 * D),
    };
    assert.equal(isFactFresh(decision), true);
    assert.equal(getFactFreshness(decision, new Date(), { decision: 30 * D }).stale, true);
  });

  it("falls back to timestamp for missing/malformed stamps", () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    // Legacy: NO lastVerifiedAt → ages from creation (365d fact budget → stale).
    const legacy = { fact: "older fact", timestamp: old };
    assert.equal(isFactFresh(legacy), false, "legacy entries age from creation");
    assert.equal(getFactFreshness(legacy).reference, old, "falls back to timestamp");
    // Malformed stamp → falls back to timestamp + the reference reflects that.
    const malformed = { fact: "malformed", timestamp: old, lastVerifiedAt: "not-a-date" };
    assert.equal(getFactFreshness(malformed).reference, old);
    // Unusable fallback (no usable timestamp at all) → stale, record kept.
    const broken = { fact: "broken", timestamp: "nope" };
    const freshness = getFactFreshness(broken);
    assert.equal(freshness.stale, true, "unusable fallback is stale");
    assert.equal(freshness.reference, null);
  });

  it("loads legacy entries from disk, keeps them, and derives stable ids", () => {
    const path = join(cwd, ".pi", "yoowai");
    mkdirSync(path, { recursive: true });
    const legacyStamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(path, "learned.json"),
      JSON.stringify({
        facts: [
          { fact: "legacy no stamp", timestamp: legacyStamp },
          { fact: "legacy malformed stamp", timestamp: legacyStamp, lastVerifiedAt: "not-a-date" },
        ],
        updatedAt: legacyStamp,
      }),
    );

    // Retained + stale status derived from the timestamp fallback.
    const loaded = loadLearnedFacts(cwd);
    assert.equal(loaded.length, 2, "legacy entries must be retained");
    for (const f of loaded) {
      assert.equal(isFactFresh(f), false, "no stamp / broken stamp → ages from creation → stale");
      assert.ok(f.id, "legacy entries get a derived id");
      assert.ok(f.id.startsWith(f.timestamp), "derived id is anchored to the entry");
    }
    // Stable across repeated loads (deterministic derivation).
    const again = loadLearnedFacts(cwd);
    assert.equal(again[0].id, loaded[0].id);
    assert.equal(again[1].id, loaded[1].id);
    // A save persists the derived ids.
    recordLearnedFact(cwd, "new fact");
    const persisted = JSON.parse(readFileSync(join(path, "learned.json"), "utf-8")) as {
      facts: Array<{ id?: string }>;
    };
    assert.equal(persisted.facts.length, 3);
    assert.ok(
      persisted.facts.every((f) => f.id),
      "ids persisted on next save",
    );
  });

  it("lists stale entries and never writes on read", () => {
    recordLearnedFact(cwd, "Fresh fact.");
    recordLearnedFact(cwd, "Old decision.", { kind: "decision" });
    // Force the second entry stale (mirror legacy age) by rewriting its stamp on disk.
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    const staleEntry = store.facts.find((f) => f.fact === "Old decision.")!;
    staleEntry.lastVerifiedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    staleEntry.timestamp = staleEntry.lastVerifiedAt;
    writeFileSync(path, JSON.stringify(store));
    const before = readFileSync(path, "utf-8");

    const stale = listStaleFacts(cwd);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].fact, "Old decision.");
    // Query filtering narrows to matching stale entries only.
    const queried = listStaleFacts(cwd, "decision");
    assert.equal(queried.length, 1);
    assert.equal(listStaleFacts(cwd, "nothing-matches").length, 0);
    // Listing/filtering does not renew or modify the store on disk.
    assert.equal(readFileSync(path, "utf-8"), before);
    // Ordinary listing stays INCLUSIVE (stale + fresh, newest first).
    const all = findLearnedFacts(cwd);
    assert.equal(all.length, 2);
    // The mixed listing marks stale entries with marker + hint, fresh unmarked.
    const rendered = formatLearnedFactsWithFreshness(all);
    assert.match(rendered, /STALE.*Old decision.*verify, update, or revoke/);
    assert.ok(!/STALE.*Fresh fact/.test(rendered), "the fresh entry must not be marked stale");
  });

  it("read/lookup/re-record never renew stamps; only a fresh record starts verified", () => {
    recordLearnedFact(cwd, "Stable fact.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const oldStamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    store.facts[0].lastVerifiedAt = oldStamp;
    writeFileSync(path, JSON.stringify(store));

    // Reads and lookups leave the stamp untouched.
    loadLearnedFacts(cwd);
    findLearnedFacts(cwd, "Stable");
    listStaleFacts(cwd);
    formatLearnedFactsWithFreshness(loadLearnedFacts(cwd));
    assert.equal(loadLearnedFacts(cwd)[0].lastVerifiedAt, oldStamp, "reads must not renew");
    // Re-recording the same fact adds a NEW entry (old one untouched).
    recordLearnedFact(cwd, "Stable fact.");
    const after = loadLearnedFacts(cwd);
    assert.equal(after[0].lastVerifiedAt, oldStamp, "the existing entry keeps its stamp");
    assert.notEqual(after[1].lastVerifiedAt, oldStamp, "the new record starts with its own stamp");
  });

  it("renews on meaningful verification only", () => {
    recordLearnedFact(cwd, "Auth uses Clerk.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    // Seed a known old stamp so same-millisecond recording can't mask renewal.
    const oldStamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    store.facts[0].lastVerifiedAt = oldStamp;
    store.facts[0].timestamp = oldStamp;
    writeFileSync(path, JSON.stringify(store));

    // valid → renew (identity from the entry snapshot: id + timestamp).
    const entry = loadLearnedFacts(cwd)[0];
    assert.equal(
      markFactVerified(cwd, "Auth uses Clerk.", { status: "valid", reasons: [] }, entry.id, entry.timestamp),
      true,
    );
    const renewed = loadLearnedFacts(cwd)[0];
    assert.notEqual(renewed.lastVerifiedAt, oldStamp, "stamp must move off the known-old value");
    // questionable/outdated → NO renewal.
    const stamp = renewed.lastVerifiedAt;
    assert.equal(
      markFactVerified(cwd, "Auth uses Clerk.", { status: "questionable", reasons: [] }, entry.id, entry.timestamp),
      false,
    );
    assert.equal(
      markFactVerified(cwd, "Auth uses Clerk.", { status: "outdated", reasons: [] }, entry.id, entry.timestamp),
      false,
    );
    assert.equal(loadLearnedFacts(cwd)[0].lastVerifiedAt, stamp, "non-valid outcomes must not renew");
    // A BARE fact text without identity never renews (may target the wrong entry).
    assert.equal(markFactVerified(cwd, "Auth uses Clerk.", { status: "valid", reasons: [] }), false);
    assert.equal(loadLearnedFacts(cwd)[0].lastVerifiedAt, stamp, "text-only call must not renew");
    // Unknown entry → false.
    assert.equal(markFactVerified(cwd, "Nope.", { status: "valid", reasons: [] }, "id-x", "t"), false);
  });

  it("reaffirms explicitly and renews", () => {
    recordLearnedFact(cwd, "Lockfile is pinned.", { kind: "decision" });
    // Seed a known old stamp so an unchanged stamp can't pass unnoticed.
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const oldStamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    store.facts[0].lastVerifiedAt = oldStamp;
    writeFileSync(path, JSON.stringify(store));

    assert.equal(reaffirmFact(cwd, "Lockfile is pinned."), "renewed");
    assert.equal(reaffirmFact(cwd, "Unknown fact."), "not-found");
    const second = loadLearnedFacts(cwd)[0];
    assert.notEqual(second.lastVerifiedAt, oldStamp, "reaffirmation must move the stamp");
    assert.ok(isFactFresh(second));
  });

  it("applies guarded renewal across verification results (partial success)", () => {
    recordLearnedFact(cwd, "Still true.");
    recordLearnedFact(cwd, "Doubtful.");
    recordLearnedFact(cwd, "Stale now.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    for (const f of store.facts) {
      f.lastVerifiedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    }
    writeFileSync(path, JSON.stringify(store));
    const before = loadLearnedFacts(cwd);
    const stamap = new Map(before.map((f) => [f.fact, f.lastVerifiedAt]));

    const results = [
      { fact: before.find((f) => f.fact === "Still true.")!, status: "valid" as const, reasons: [] },
      { fact: before.find((f) => f.fact === "Doubtful.")!, status: "questionable" as const, reasons: ["w"] },
      { fact: before.find((f) => f.fact === "Stale now.")!, status: "outdated" as const, reasons: ["x"] },
      { fact: { fact: "Unknown.", timestamp: "t" }, status: "valid" as const, reasons: [] },
    ];
    const renewed = applyVerifiedRenewals(cwd, results);
    assert.equal(renewed, 1, "only the valid, known entry renews");
    const after = loadLearnedFacts(cwd);
    const afterStamp = new Map(after.map((f) => [f.fact, f.lastVerifiedAt]));
    assert.notEqual(afterStamp.get("Still true."), stamap.get("Still true."), "valid entry renewed");
    assert.equal(afterStamp.get("Doubtful."), stamap.get("Doubtful."), "questionable NOT renewed");
    assert.equal(afterStamp.get("Stale now."), stamap.get("Stale now."), "outdated NOT renewed");
    assert.equal(after.length, 3, "unknown entries never written");
  });

  it("deep verify: empty/malformed/partial responses are unconfirmed and never renew", async () => {
    recordLearnedFact(cwd, "Auth uses Clerk.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const oldStamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    store.facts[0].lastVerifiedAt = oldStamp;
    writeFileSync(path, JSON.stringify(store));

    const cases = [
      "",
      "garbage without status",
      "STATUS: \nREASON: x",
      "STATUS: validated",
      "XSTATUS: valid",
      "STATUS: valid-garbage\nREASON: x",
      "STATUS: valid\nSTATUS: outdated\nREASON: conflicting result",
      "STATUS: valid\nREASON: first\nREASON: second",
      "STATUS: valid\nSTATUS: unknown\nREASON: ok",
      "STATUS: valid\nREASON: ok\n(extra prose)",
      "STATUS: valid",
      "Preamble before the structured payload.\nSTATUS: valid\nREASON: ok",
      "XSTATUS: valid\nREASON: ok",
    ];
    for (const content of cases) {
      const caller = async () => ({
        content,
        usage: { estimatedInputTokens: 10, estimatedOutputTokens: 5, estimatedCostUsd: 0.0001, sessionCostUsd: 0.0001 },
      });
      const { results } = await verifyLearnedFactsDeep(cwd, undefined, undefined, () => {}, undefined, caller);
      assert.equal(
        results[0].status,
        "questionable",
        `malformed deep response must be unconfirmed (${JSON.stringify(content)})`,
      );
      assert.equal(applyVerifiedRenewals(cwd, results), 0, "unconfirmed deep results must never renew");
      assert.equal(loadLearnedFacts(cwd)[0].lastVerifiedAt, oldStamp, "stamp must stay unchanged");
    }
  });

  it("renews duplicate fact texts by their own per-entry id", () => {
    recordLearnedFact(cwd, "Dup fact.");
    recordLearnedFact(cwd, "Dup fact.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    const [first, second] = store.facts;
    // Force BOTH to share the SAME timestamp AND stamp; ids are distinct.
    const sameMs = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString();
    first.timestamp = sameMs;
    second.timestamp = sameMs;
    first.lastVerifiedAt = sameMs;
    second.lastVerifiedAt = sameMs;
    writeFileSync(path, JSON.stringify(store));

    const before = loadLearnedFacts(cwd);
    const [b0, b1] = before;
    assert.notEqual(b0.id, b1.id, "even same-ms duplicates must have distinct ids");
    const renewed = applyVerifiedRenewals(cwd, [
      { fact: b0, status: "valid", reasons: [] },
      { fact: b1, status: "valid", reasons: [] },
    ]);
    assert.equal(renewed, 2, "BOTH duplicate entries renew");
    const after = loadLearnedFacts(cwd);
    assert.notEqual(after[0].lastVerifiedAt, sameMs);
    assert.notEqual(after[1].lastVerifiedAt, sameMs);

    // Shared fact+timestamp WITHOUT an id is ambiguous → neither renews.
    const sharedStamp = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const store2 = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    const anyA = store2.facts.find((f) => f.fact === "Dup fact.")!;
    anyA.lastVerifiedAt = sharedStamp;
    anyA.timestamp = sharedStamp;
    const anyB = store2.facts.find((f) => f.fact === "Dup fact." && f !== anyA)!;
    anyB.lastVerifiedAt = sharedStamp;
    anyB.timestamp = sharedStamp;
    writeFileSync(path, JSON.stringify(store2));
    const beforeAmbig = loadLearnedFacts(cwd);
    assert.equal(
      markFactVerified(cwd, "Dup fact.", { status: "valid", reasons: [] }, undefined, sharedStamp),
      false,
      "shared fact+timestamp without id is ambiguous — must not renew",
    );
    const afterAmbig = loadLearnedFacts(cwd);
    assert.equal(afterAmbig[0].lastVerifiedAt, beforeAmbig[0].lastVerifiedAt, "neither duplicate renews");
    assert.equal(afterAmbig[1].lastVerifiedAt, beforeAmbig[1].lastVerifiedAt);
  });

  it("reaffirm rejects ambiguous duplicate text and reports outcomes", () => {
    recordLearnedFact(cwd, "Dup fact.");
    recordLearnedFact(cwd, "Dup fact.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    const oldStamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    store.facts[0].lastVerifiedAt = oldStamp;
    store.facts[1].lastVerifiedAt = oldStamp;
    writeFileSync(path, JSON.stringify(store));

    // Duplicate text without id → ambiguous; nothing changes.
    assert.equal(reaffirmFact(cwd, "Dup fact."), "ambiguous");
    assert.equal(reaffirmFact(cwd, "Never recorded."), "not-found");
    const untouched = loadLearnedFacts(cwd);
    assert.equal(untouched[0].lastVerifiedAt, oldStamp, "ambiguous call left entry 0 unchanged");
    assert.equal(untouched[1].lastVerifiedAt, oldStamp, "ambiguous call left entry 1 unchanged");

    // By stable id: exactly one entry renews (other keeps its old stamp).
    assert.equal(reaffirmFact(cwd, "Dup fact.", untouched[0].id), "renewed");
    const after = loadLearnedFacts(cwd);
    assert.notEqual(after[0].lastVerifiedAt, oldStamp, "id-selected entry renewed");
    assert.equal(after[1].lastVerifiedAt, oldStamp, "the other duplicate keeps its stamp");
  });

  it("fresh-only filtering yields the full fresh set before any caller-side limit", () => {
    // 25 fresh + 5 stale (recorded last → sort ahead as newest). A caller that
    // slices to 20 BEFORE filtering would lose fresh entries to stale ones.
    for (let i = 0; i < 25; i++) {
      recordLearnedFact(cwd, `fresh ${i}`);
    }
    for (let i = 0; i < 5; i++) {
      recordLearnedFact(cwd, `stale ${i}`);
    }
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    for (const f of store.facts) {
      if (f.fact.startsWith("stale ")) {
        f.lastVerifiedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
      }
    }
    writeFileSync(path, JSON.stringify(store));
    const before = readFileSync(path, "utf-8");

    const all = findLearnedFacts(cwd);
    assert.equal(all.length, 30, "ordinary listing is inclusive");
    const fresh = all.filter((f) => isFactFresh(f));
    assert.equal(fresh.length, 25, "all 25 fresh survive freshness filtering");
    assert.equal(fresh[0].fact, "fresh 24", "the 5 stale entries did not displace the freshest fresh one");
    const slicing = fresh.slice(0, 20);
    assert.equal(slicing.length, 20);
    assert.equal(fresh[24].fact, "fresh 0", "the full fresh set exists for a caller-side slice");
    assert.equal(readFileSync(path, "utf-8"), before, "filtering never writes");
  });

  it("rejects invalid kinds (recorded as plain facts)", () => {
    // The public tool passes only 'fact' | 'decision'; a stray invalid kind
    // must not poison the store — it records as a plain fact (kind undefined).
    const entry = recordLearnedFact(cwd, "Some note.", { kind: "bogus" as never });
    assert.equal(entry.kind, undefined);
    assert.equal(findLearnedFacts(cwd, undefined, "decision").length, 0);
    assert.equal(findLearnedFacts(cwd).length, 1);
  });

  it("records decisions and filters by kind", () => {
    recordLearnedFact(cwd, "Use camelCase.", { category: "conventions" });
    recordLearnedFact(cwd, "Never update the lockfile manually.", { kind: "decision", source: "review" });

    const decisions = findLearnedFacts(cwd, undefined, "decision");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.kind, "decision");
    assert.equal(decisions[0]?.fact, "Never update the lockfile manually.");
    assert.equal(decisions[0]?.source, "review");

    const facts = findLearnedFacts(cwd, undefined, "fact");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.kind, undefined, "plain facts keep kind undefined (legacy-compatible)");

    // All kinds together (no filter), newest first.
    const all = findLearnedFacts(cwd);
    assert.equal(all.length, 2);
    assert.equal(all[0]?.kind, "decision", "newest first");
  });

  it("records and loads facts", () => {
    recordLearnedFact(cwd, "Use camelCase.", { category: "conventions" });
    recordLearnedFact(cwd, "Auth uses Clerk.", { category: "auth", source: "README.md" });

    const facts = loadLearnedFacts(cwd);
    assert.equal(facts.length, 2);
    assert.ok(facts.some((f) => f.fact === "Use camelCase."));
  });

  it("finds facts by query", () => {
    recordLearnedFact(cwd, "Use camelCase.", { category: "conventions" });
    recordLearnedFact(cwd, "Auth uses Clerk.", { category: "auth" });

    const found = findLearnedFacts(cwd, "auth");
    assert.equal(found.length, 1);
    assert.equal(found[0].fact, "Auth uses Clerk.");
  });

  it("formats facts", () => {
    recordLearnedFact(cwd, "Use camelCase.", { category: "conventions" });
    const text = formatLearnedFacts(loadLearnedFacts(cwd));
    assert.match(text, /\[conventions\] Use camelCase\./);
  });

  it("clears facts", () => {
    recordLearnedFact(cwd, "Use camelCase.");
    clearLearnedFacts(cwd);
    assert.equal(loadLearnedFacts(cwd).length, 0);
    assert.ok(existsSync(join(cwd, ".pi", "yoowai", "learned.json")));
  });

  it("flags outdated facts with missing files", () => {
    recordLearnedFact(cwd, "Old logic lives in src/old.ts", { source: "src/old.ts" });
    const results = verifyLearnedFacts(cwd);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "outdated");
    assert.match(results[0].reasons.join(" "), /src\/old\.ts/);
  });

  it("flags questionable facts with missing symbols", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "export const demo = 1;", "utf-8");
    saveProjectIndex(cwd, buildProjectIndex(cwd));

    recordLearnedFact(cwd, "Call removedFunction() to reset state.");
    const results = verifyLearnedFacts(cwd);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "questionable");
    assert.match(results[0].reasons.join(" "), /removedFunction/);
  });

  it("marks facts valid when references exist", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "export const demo = 1;", "utf-8");
    saveProjectIndex(cwd, buildProjectIndex(cwd));

    recordLearnedFact(cwd, "Use the demo export in src/demo.ts.");
    const results = verifyLearnedFacts(cwd);
    assert.equal(results[0].status, "valid");
    assert.match(formatVerificationReport(results), /1 valid/);
  });

  it("deep verify uses the model caller", async () => {
    recordLearnedFact(cwd, "Auth uses Clerk.");
    const caller = async () => ({
      content: "STATUS: questionable\nREASON: No Clerk references found.",
      usage: {
        estimatedInputTokens: 10,
        estimatedOutputTokens: 5,
        estimatedCostUsd: 0.0001,
        sessionCostUsd: 0.0001,
      },
    });
    const { results, cost } = await verifyLearnedFactsDeep(cwd, undefined, undefined, () => {}, undefined, caller);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "questionable");
    assert.match(results[0].reasons[0], /No Clerk references/);
    assert.ok(cost.estimatedCostUsd > 0);
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
    assert.ok(true);
  });
});
