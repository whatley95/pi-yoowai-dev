import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeWaiScan } from "./scan.js";
import { gatherDeepScanSamples, scanProjectConventions } from "../conventions.js";
import { loadProjectIndex } from "../project-index.js";

async function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "wai-scan-reuse-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, "main.ts"), "export function main() { return 1; }\n");
  let calls = 0;
  let invalid = false;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: invalid
                  ? "not conventions"
                  : JSON.stringify({
                      naming: "camelCase",
                      structure: "root source",
                      stack: "TypeScript",
                      patterns: [],
                      entryPoints: [],
                      scripts: [],
                    }),
              },
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const settings = {
    "pi-yoowai": {
      secondary: {
        provider: "openai",
        id: "scan-test",
        backend: "http",
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key",
        thinking: "off",
        contextWindow: 16000,
        maxOutputTokens: 2048,
      },
    },
  };
  const taskSettings = { ...settings["pi-yoowai"], taskModels: { scan: { ...settings["pi-yoowai"].secondary } } };
  const isolatedSettings = { "pi-yoowai": taskSettings };
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(isolatedSettings));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    settings: isolatedSettings,
    calls: () => calls,
    invalid: () => {
      invalid = true;
    },
    scan: (deep = false, refresh = false) => executeWaiScan(cwd, undefined, () => {}, undefined, deep, refresh),
  };
}

it("reuses matching scan inputs without a model call and refreshes after meaningful input changes", async (t) => {
  const f = await fixture(t);
  assert.ok((await f.scan()).scan);
  const cached = await f.scan();
  assert.equal(cached.scan?.cached, true);
  assert.equal(cached.cost, undefined, "reuse must not record another model charge");
  assert.equal(f.calls(), 1);
  await f.scan(false, true);
  assert.equal(f.calls(), 2, "explicit refresh bypasses reuse");
  writeFileSync(join(f.cwd, "added.ts"), "export const added = true;\n");
  assert.notEqual((await f.scan()).scan?.cached, true);
  assert.equal(f.calls(), 3);
  mkdirSync(join(f.cwd, ".pi", "yoowai", "instructions"), { recursive: true });
  writeFileSync(join(f.cwd, ".pi", "yoowai", "instructions", "scan.md"), "Identify source layout precisely.");
  await f.scan();
  assert.equal(f.calls(), 4, "changed scan instructions invalidate reuse");
  const conventionsPath = join(f.cwd, ".pi", "yoowai", "conventions.json");
  const conventions = JSON.parse(readFileSync(conventionsPath, "utf-8"));
  conventions.naming = "manually edited convention";
  writeFileSync(conventionsPath, JSON.stringify(conventions));
  await f.scan();
  assert.equal(f.calls(), 5, "manual changes to the saved output invalidate reuse");
  f.settings["pi-yoowai"].taskModels.scan.id = "another-scan-model";
  writeFileSync(join(f.cwd, ".pi", "settings.json"), JSON.stringify(f.settings));
  await f.scan();
  assert.equal(f.calls(), 6, "model changes invalidate reuse");
});

it("does not cache a malformed secondary response", async (t) => {
  const f = await fixture(t);
  f.invalid();
  await f.scan();
  assert.notEqual((await f.scan()).scan?.cached, true);
  assert.equal(f.calls(), 2);
});

it("refreshes the entire symbol graph on reuse and does not extend the 24-hour cache lifetime", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 7; i++) writeFileSync(join(f.cwd, `extra-${i}.ts`), `export const extra${i} = ${i};\n`);
  const local = scanProjectConventions(f.cwd);
  const sampled = new Set(gatherDeepScanSamples(f.cwd, local.files, 5).map((sample) => sample.file));
  const unsampled = local.files.find(
    (file) =>
      file.startsWith("extra-") &&
      !sampled.has(file) &&
      readFileSync(join(f.cwd, file), "utf-8").trim() !== local.conventions.styleSample?.trim(),
  );
  assert.ok(unsampled);
  await f.scan(true);
  const cachePath = join(f.cwd, ".pi", "yoowai", "scan-cache.json");
  const entry = JSON.parse(readFileSync(cachePath, "utf-8"));
  entry.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeFileSync(cachePath, JSON.stringify(entry));
  const original = readFileSync(join(f.cwd, unsampled), "utf-8");
  writeFileSync(join(f.cwd, unsampled), original.replace("extra", "fresh"));
  assert.equal((await f.scan(true)).scan?.cached, true);
  assert.equal(f.calls(), 1);
  assert.ok(
    loadProjectIndex(f.cwd)?.files.some((file) => file.symbols.some((symbol) => symbol.name.startsWith("fresh"))),
  );
  assert.equal(JSON.parse(readFileSync(cachePath, "utf-8")).createdAt, entry.createdAt);
  entry.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  // Keep the output hash from the refreshed graph.
  const updated = JSON.parse(readFileSync(cachePath, "utf-8"));
  writeFileSync(cachePath, JSON.stringify({ ...updated, createdAt: entry.createdAt }));
  assert.notEqual((await f.scan(true)).scan?.cached, true);
  assert.equal(f.calls(), 2, "expired scans must call the model again");
});
