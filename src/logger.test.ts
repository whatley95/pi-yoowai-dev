import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { logEvent, readRecentLogs } from "./logger.js";

describe("logEvent timestamps", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "wai-logger-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes local time with an explicit numeric offset, not UTC Zulu", () => {
    logEvent(dir, "info", "timestamp probe");
    const lines = readRecentLogs(dir, 1);
    assert.equal(lines.length, 1);
    const match = lines[0].match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})([+-]\d{2}:\d{2})\]/);
    assert.ok(match, `timestamp missing or malformed: ${lines[0]}`);
    // The offset must reflect the machine's actual timezone.
    const expectedOffsetMinutes = -new Date().getTimezoneOffset();
    const sign = expectedOffsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(expectedOffsetMinutes);
    const expected = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    assert.equal(match[2], expected);
  });

  it("log file lands under .pi/yoowai/wai.log", () => {
    const content = readFileSync(join(dir, ".pi", "yoowai", "wai.log"), "utf-8");
    assert.ok(content.includes("timestamp probe"));
  });
});
