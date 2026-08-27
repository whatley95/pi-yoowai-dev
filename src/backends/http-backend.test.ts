import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { callHttpBackend, parseSseEvents } from "./http-backend.js";
import type { ProviderApiInfo } from "../types/secondary-model.js";

describe("parseSseEvents", () => {
  it("parses multiple complete events and keeps the remainder", () => {
    const { events, remainder } = parseSseEvents(
      'event: message_start\ndata: {"type":"start"}\n\nevent: content_block_delta\ndata: {"type":"delta"}\n\nevent: partial',
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, "message_start");
    assert.equal(events[0]?.data, '{"type":"start"}');
    assert.equal(events[1]?.event, "content_block_delta");
    assert.equal(events[1]?.data, '{"type":"delta"}');
    assert.equal(remainder, "event: partial");
  });

  it("parses a final event without a trailing blank line when final=true", () => {
    const { events, remainder } = parseSseEvents(
      'event: content_block_delta\ndata: {"type":"delta"}\n\nevent: message_stop\ndata: {"type":"stop"}',
      true,
    );
    assert.equal(events.length, 2);
    assert.equal(events[1]?.event, "message_stop");
    assert.equal(events[1]?.data, '{"type":"stop"}');
    // The remainder was consumed as the final event.
    assert.equal(remainder, "");
  });

  it("parses a single trailing event when final=true and there is no separator at all", () => {
    const { events, remainder } = parseSseEvents('event: message_stop\ndata: {"type":"stop"}', true);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "message_stop");
    assert.equal(remainder, "");
  });

  it("returns an empty result for a partial buffer when final=false", () => {
    const { events, remainder } = parseSseEvents('event: message_start\ndata: {"type":"start"}');
    assert.equal(events.length, 0);
    assert.equal(remainder, 'event: message_start\ndata: {"type":"start"}');
  });

  it("parses CRLF streams identically to LF streams", () => {
    const crlf = parseSseEvents(
      'event: message_start\r\ndata: {"type":"start"}\r\n\r\nevent: content_block_delta\r\ndata: {"type":"delta"}\r\n\r\n',
    );
    const lf = parseSseEvents(
      'event: message_start\ndata: {"type":"start"}\n\nevent: content_block_delta\ndata: {"type":"delta"}\n\n',
    );
    assert.deepEqual(crlf, lf);
    assert.equal(crlf.events.length, 2);
    assert.equal(crlf.events[1]?.data, '{"type":"delta"}');
  });

  it("parses a CRLF final event without a trailing blank line when final=true", () => {
    const { events } = parseSseEvents('event: message_stop\r\ndata: {"type":"stop"}', true);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data, '{"type":"stop"}');
  });

  it("joins multi-line data fields with newlines", () => {
    const { events } = parseSseEvents("data: line one\ndata: line two\n\n");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data, "line one\nline two");
  });

  it("skips comment-only and blank events", () => {
    const { events } = parseSseEvents(
      ": keep-alive comment\n\nevent: ping\ndata: ping\n\n\n\nevent: real\ndata: {}\n\n",
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, "ping");
    assert.equal(events[1]?.event, "real");
  });

  it("handles empty buffers", () => {
    assert.deepEqual(parseSseEvents(""), { events: [], remainder: "" });
    assert.deepEqual(parseSseEvents("", true), { events: [], remainder: "" });
  });
});

const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

/** A server that counts requests and answers every one with 500. */
async function startFailingServer(): Promise<{ url: string; attempts: () => number }> {
  let count = 0;
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((_req: IncomingMessage, res: ServerResponse) => {
      count += 1;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stub failure" }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub server has no port");
  return { url: `http://127.0.0.1:${address.port}`, attempts: () => count };
}

function apiInfoFor(url: string): ProviderApiInfo {
  return {
    style: "openai-compatible",
    baseUrl: url,
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  };
}

describe("callHttpBackend retry behavior", () => {
  it("maxRetries: 0 makes exactly one attempt on a 500", async () => {
    const { url, attempts } = await startFailingServer();
    await assert.rejects(
      callHttpBackend(
        "openai",
        apiInfoFor(url),
        "test-key",
        "gpt-4o-mini",
        "sys",
        "user",
        undefined,
        "off",
        undefined,
        undefined,
        false,
        0,
      ),
      /Secondary model request failed/,
    );
    assert.equal(attempts(), 1, "maxRetries: 0 must disable retries");
  });

  it("unset maxRetries keeps the default of two retries (three attempts)", async () => {
    const { url, attempts } = await startFailingServer();
    await assert.rejects(
      callHttpBackend("openai", apiInfoFor(url), "test-key", "gpt-4o-mini", "sys", "user", undefined, "off"),
      /Secondary model request failed/,
    );
    assert.equal(attempts(), 3, "the default must retry twice");
  });

  it("maxRetries: 2 makes three attempts", async () => {
    const { url, attempts } = await startFailingServer();
    await assert.rejects(
      callHttpBackend(
        "openai",
        apiInfoFor(url),
        "test-key",
        "gpt-4o-mini",
        "sys",
        "user",
        undefined,
        "off",
        undefined,
        undefined,
        false,
        2,
      ),
      /Secondary model request failed/,
    );
    assert.equal(attempts(), 3);
  });

  it("the reasoning-disabled fallback honors maxRetries: 0", async () => {
    // First request: a 200 whose content is empty with reasoning_content and
    // finish_reason "length" — triggers the one-shot reasoning-disabled
    // fallback. Every later request: 500. With maxRetries: 0 the total is
    // exactly 2 attempts (initial + one fallback, no retries); a regression
    // in forwarding maxRetries to the recursive call would add the default
    // two retries (4 attempts).
    let count = 0;
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((_req: IncomingMessage, res: ServerResponse) => {
        count += 1;
        if (count === 1) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: { content: "", reasoning_content: "thinking..." },
                  finish_reason: "length",
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "stub failure" }));
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub server has no port");

    await assert.rejects(
      callHttpBackend(
        "openai",
        apiInfoFor(`http://127.0.0.1:${address.port}`),
        "test-key",
        "gpt-4o-mini",
        "sys",
        "user",
        undefined,
        "high",
        undefined,
        undefined,
        false,
        0,
      ),
      /Secondary model request failed/,
    );
    assert.equal(count, 2, "fallback + maxRetries: 0 must total exactly 2 attempts");
  });

  it("invalid maxRetries values normalize to the default (3 attempts)", async () => {
    // Includes over-cap values: the exponential backoff would overflow.
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 11, 1000]) {
      const { url, attempts } = await startFailingServer();
      await assert.rejects(
        callHttpBackend(
          "openai",
          apiInfoFor(url),
          "test-key",
          "gpt-4o-mini",
          "sys",
          "user",
          undefined,
          "off",
          undefined,
          undefined,
          false,
          invalid,
        ),
        /Secondary model request failed/,
      );
      assert.equal(attempts(), 3, `invalid maxRetries ${invalid} must fall back to 2 retries`);
    }
  });
});
