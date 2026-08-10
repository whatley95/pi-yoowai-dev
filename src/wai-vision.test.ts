import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
  executeWaiVision,
  imageMimeType,
  isSupportedVisionPath,
  loadVisionImage,
  loadVisionInput,
  loadVisionPdf,
  validateWaiVisionParams,
  VISION_MAX_IMAGE_BYTES,
} from "./wai-vision.js";
import { buildPdfAnalysisPrompt, buildVisionPrompt } from "./prompts.js";
import { callSecondaryModel, setSdkGetModelOverride, setSdkStreamSimpleOverride } from "./secondary-model.js";

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeSettings(cwd: string, secondary: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ "pi-yoowai": { secondary, ...extra } }, null, 2),
    "utf-8",
  );
}

function fakeSdkModel(provider: string, modelId: string, input: ("text" | "image")[]): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.com",
    reasoning: false,
    input,
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<Api>;
}

function fakeSdkAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } satisfies Partial<Usage> as Usage,
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function fakeSdkStream(message: AssistantMessage): import("@earendil-works/pi-ai").AssistantMessageEventStream {
  return {
    result: async () => message,
    [Symbol.asyncIterator]: async function* () {
      yield { type: "done", reason: "stop", message };
    },
  } as unknown as import("@earendil-works/pi-ai").AssistantMessageEventStream;
}

/** Minimal one-page PDF with a Helvetica text layer (mupdf repairs the missing xref). */
function textPdf(text: string): Buffer {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
      "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      "5 0 obj << /Length 40 >> stream",
      `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`,
      "endstream endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n"),
  );
}

/** Minimal one-page PDF with no content stream (no text layer). */
function blankPdf(): Buffer {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n"),
  );
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

afterEach(() => {
  setSdkGetModelOverride(null);
  setSdkStreamSimpleOverride(null);
});

describe("wai-vision params", () => {
  it("validates params with path", () => {
    const result = validateWaiVisionParams({ path: "docs/shot.png" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.params.path, "docs/shot.png");
      assert.equal(result.params.question, undefined);
    }
  });

  it("rejects missing or empty path", () => {
    assert.equal(validateWaiVisionParams({ question: "what is this?" }).ok, false);
    assert.equal(validateWaiVisionParams({ path: "" }).ok, false);
    assert.equal(validateWaiVisionParams("docs/shot.png").ok, false);
  });

  it("accepts optional question and context", () => {
    const result = validateWaiVisionParams({ path: "a.png", question: "broken?", context: "after my change" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.params.question, "broken?");
      assert.equal(result.params.context, "after my change");
    }
  });
});

describe("wai-vision image loading", () => {
  it("maps extensions to mime types case-insensitively", () => {
    assert.equal(imageMimeType("a.png"), "image/png");
    assert.equal(imageMimeType("a.JPG"), "image/jpeg");
    assert.equal(imageMimeType("a.jpeg"), "image/jpeg");
    assert.equal(imageMimeType("a.webp"), "image/webp");
    assert.equal(imageMimeType("a.gif"), "image/gif");
    assert.equal(imageMimeType("a.txt"), undefined);
    assert.equal(imageMimeType("noext"), undefined);
  });

  it("rejects path traversal", () => {
    const cwd = makeTempDir("wai-vision-traverse-");
    const result = loadVisionImage(cwd, "../secret.png");
    assert.equal(result.ok, false);
  });

  it("rejects unsupported extensions", () => {
    const cwd = makeTempDir("wai-vision-ext-");
    writeFileSync(join(cwd, "notes.txt"), "hello");
    const result = loadVisionImage(cwd, "notes.txt");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Unsupported image type/);
  });

  it("rejects missing files", () => {
    const cwd = makeTempDir("wai-vision-missing-");
    const result = loadVisionImage(cwd, "nope.png");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not found/i);
  });

  it("rejects images over the size cap", () => {
    const cwd = makeTempDir("wai-vision-big-");
    writeFileSync(join(cwd, "big.png"), Buffer.alloc(VISION_MAX_IMAGE_BYTES + 1, 1));
    const result = loadVisionImage(cwd, "big.png");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /too large/i);
  });

  it("loads a valid image as base64", () => {
    const cwd = makeTempDir("wai-vision-ok-");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(join(cwd, "shot.png"), bytes);
    const result = loadVisionImage(cwd, "shot.png");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mimeType, "image/png");
      assert.equal(Buffer.from(result.data, "base64").equals(bytes), true);
    }
  });
});

describe("wai-vision pdf loading", () => {
  it("accepts .pdf as a supported path", () => {
    assert.equal(isSupportedVisionPath("doc.pdf"), true);
    assert.equal(isSupportedVisionPath("doc.PDF"), true);
    assert.equal(isSupportedVisionPath("doc.png"), true);
    assert.equal(isSupportedVisionPath("doc.txt"), false);
  });

  it("extracts the text layer from a text PDF", async () => {
    const cwd = makeTempDir("wai-vision-pdf-text-");
    writeFileSync(join(cwd, "invoice.pdf"), textPdf("INVOICE-6VXU7PB7-0001 Total: 42.00 due 2026-08-31"));
    const result = await loadVisionPdf(cwd, "invoice.pdf");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.input.kind, "text");
      if (result.input.kind === "text") {
        assert.match(result.input.text, /INVOICE-6VXU7PB7-0001/);
        assert.equal(result.input.pages, 1);
      }
    }
  });

  it("renders pages to PNG when the PDF has no text layer", async () => {
    const cwd = makeTempDir("wai-vision-pdf-blank-");
    writeFileSync(join(cwd, "scanned.pdf"), blankPdf());
    const result = await loadVisionPdf(cwd, "scanned.pdf");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.input.kind, "image");
      if (result.input.kind === "image") {
        assert.equal(result.input.mimeType, "application/pdf");
        assert.equal(result.input.images.length, 1);
        const png = Buffer.from(result.input.images[0].data, "base64");
        assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      }
    }
  });

  it("rejects missing and out-of-project PDFs", async () => {
    const cwd = makeTempDir("wai-vision-pdf-missing-");
    assert.equal((await loadVisionPdf(cwd, "nope.pdf")).ok, false);
    assert.equal((await loadVisionPdf(cwd, "../secret.pdf")).ok, false);
  });

  it("rejects corrupt PDFs with a parse error", async () => {
    const cwd = makeTempDir("wai-vision-pdf-corrupt-");
    writeFileSync(join(cwd, "broken.pdf"), Buffer.from("not a pdf at all"));
    const result = await loadVisionPdf(cwd, "broken.pdf");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Cannot parse PDF/);
  });

  it("dispatches .pdf through loadVisionInput", async () => {
    const cwd = makeTempDir("wai-vision-pdf-dispatch-");
    writeFileSync(join(cwd, "doc.pdf"), textPdf("DISPATCH-TEST-1234 some more text here to pass the threshold"));
    const result = await loadVisionInput(cwd, "doc.pdf");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.input.kind, "text");
  });
});

describe("wai-vision pdf prompt", () => {
  it("includes extracted text, question, and context", () => {
    const { system, user } = buildPdfAnalysisPrompt(
      "docs/invoice.pdf",
      "Total: 42.00",
      1,
      "what is the total?",
      "billing",
    );
    assert.match(system, /PDF document text/i);
    assert.match(user, /docs\/invoice\.pdf \(1 page\)/);
    assert.match(user, /what is the total\?/);
    assert.match(user, /billing/);
    assert.match(user, /<pdf_text>\nTotal: 42\.00\n<\/pdf_text>/);
  });

  it("falls back to a default analysis question", () => {
    const { user } = buildPdfAnalysisPrompt("doc.pdf", "text", 3);
    assert.match(user, /\(3 pages\)/);
    assert.match(user, /Analyze this document/);
  });
});

describe("wai-vision prompt", () => {
  it("includes the question and context when given", () => {
    const { system, user } = buildVisionPrompt("docs/ui.png", "does this match?", "settings dialog");
    assert.match(system, /Analyze the attached image/i);
    assert.match(user, /docs\/ui\.png/);
    assert.match(user, /does this match\?/);
    assert.match(user, /settings dialog/);
  });

  it("falls back to a full-analysis question", () => {
    const { user } = buildVisionPrompt("docs/ui.png");
    assert.match(user, /Analyze this image/);
  });
});

describe("wai-vision model call", () => {
  it("rejects images on the http backend", async () => {
    const cwd = makeTempDir("wai-vision-http-");
    writeSettings(cwd, { provider: "openai", id: "gpt-4o", backend: "http", apiKey: "sk-test" });
    await assert.rejects(
      callSecondaryModel("openai", "gpt-4o", "sys", "usr", {
        cwd,
        images: [{ data: "aGk=", mimeType: "image/png" }],
      }),
      /sdk backend/,
    );
  });

  it("rejects images on the pi backend", async () => {
    const cwd = makeTempDir("wai-vision-pi-");
    writeSettings(cwd, { provider: "openai", id: "gpt-4o", backend: "pi", apiKey: "sk-test" });
    await assert.rejects(
      callSecondaryModel("openai", "gpt-4o", "sys", "usr", {
        cwd,
        images: [{ data: "aGk=", mimeType: "image/png" }],
      }),
      /sdk backend/,
    );
  });

  it("rejects text-only models with a clear error", async () => {
    const cwd = makeTempDir("wai-vision-textonly-");
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", apiKey: "sk-test" });
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId, ["text"]));
    setSdkStreamSimpleOverride(() => fakeSdkStream(fakeSdkAssistantMessage("unreachable")));
    await assert.rejects(
      callSecondaryModel("openai", "gpt-4o-mini", "sys", "usr", {
        cwd,
        images: [{ data: "aGk=", mimeType: "image/png" }],
      }),
      /does not accept image input/,
    );
  });

  it("attaches the image block to the user message for vision models", async () => {
    const cwd = makeTempDir("wai-vision-sdk-");
    writeSettings(cwd, { provider: "openai", id: "gpt-4o", apiKey: "sk-test" });
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId, ["text", "image"]));
    let capturedContext: unknown;
    setSdkStreamSimpleOverride(((_model: unknown, context: unknown) => {
      capturedContext = context;
      return fakeSdkStream(fakeSdkAssistantMessage("vision ok"));
    }) as never);

    const { content } = await callSecondaryModel("openai", "gpt-4o", "sys", "usr", {
      cwd,
      images: [{ data: "aGk=", mimeType: "image/png" }],
    });
    assert.equal(content, "vision ok");

    const ctx = capturedContext as { messages: { content: unknown[] }[] };
    assert.deepEqual(ctx.messages[0].content, [
      { type: "text", text: "usr" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
  });

  it("sends text-layer PDFs as a plain text call, no vision model required", async () => {
    const cwd = makeTempDir("wai-vision-pdf-call-");
    writeSettings(cwd, { provider: "openai", id: "gpt-4o-mini", apiKey: "sk-test" });
    writeFileSync(join(cwd, "invoice.pdf"), textPdf("INVOICE-PDF-CALL-7 Total: 99.00 due 2026-08-31"));
    // A text-only model would throw if images were attached.
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId, ["text"]));
    let capturedContent: unknown;
    setSdkStreamSimpleOverride(((_model: unknown, context: { messages: { content: unknown }[] }) => {
      capturedContent = context.messages[0].content;
      return fakeSdkStream(fakeSdkAssistantMessage("pdf analysis ok"));
    }) as never);

    const result = await executeWaiVision(
      cwd,
      { path: "invoice.pdf", question: "what is the total?" },
      undefined,
      () => {},
    );
    assert.ok("result" in result, JSON.stringify(result));
    if ("result" in result) {
      assert.equal(result.result.details, "pdf analysis ok");
      assert.equal(result.result.mimeType, "application/pdf");
    }

    const blocks = capturedContent as { type: string; text?: string }[];
    assert.equal(blocks.length, 1, "text-layer PDFs attach no image blocks");
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text ?? "", /INVOICE-PDF-CALL-7/);
    assert.match(blocks[0].text ?? "", /what is the total\?/);
  });
});
