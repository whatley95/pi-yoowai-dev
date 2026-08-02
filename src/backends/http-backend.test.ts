import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSseEvents } from "./http-backend.js";

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
