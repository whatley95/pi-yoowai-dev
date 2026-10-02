import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, normalize } from "node:path";
import { loadYoowaiConfig, resolveTaskModel } from "./config.js";
import { callSecondaryModel } from "./secondary-model.js";
import { recordCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { resolveProjectPath } from "./path-security.js";
import { buildPdfAnalysisPrompt, buildVisionPrompt } from "./prompts.js";
import { capActionInstructions } from "./instructions.js";
import { createStreamProgressCallback } from "./actions/shared.js";
import { resolveBackendType } from "./backends/backend-resolver.js";
import type { ProgressReporter } from "./progress.js";
import type { StageProfile, UsageCost, VisionImage, VisionResult } from "./types.js";

/** Max image size sent to the secondary model (base64 inflates ~4/3 beyond this). */
export const VISION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Max PDF file size accepted for analysis. */
export const VISION_MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Pages read for text extraction; characters kept from the extracted text. */
export const VISION_MAX_PDF_TEXT_PAGES = 10;
export const VISION_MAX_PDF_TEXT_CHARS = 100_000;
/** Pages rendered to images when a PDF has no usable text layer (scanned docs). */
export const VISION_MAX_PDF_RENDER_PAGES = 3;
/** Below this much extracted text a PDF is treated as scanned and rendered instead. */
const VISION_PDF_MIN_TEXT_CHARS = 40;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Map an image file path to its mime type, or undefined for unsupported types. */
export function imageMimeType(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()];
}

/** True for paths wai_vision can analyze: a supported image or a PDF. */
export function isSupportedVisionPath(path: string): boolean {
  return imageMimeType(path) !== undefined || extname(path).toLowerCase() === ".pdf";
}

export interface YooVisionParams {
  path?: string;
  image?: { type: "image"; data: string; mimeType: string };
  question?: string;
  context?: string;
}

/** Inline Pi image blocks avoid filesystem writes and base64 in model-facing reports. */
export function validateInlineImage(
  raw: unknown,
): { ok: false; error: string } | { ok: true; image: NonNullable<YooVisionParams["image"]> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Expected an image block." };
  const block = raw as Record<string, unknown>;
  if (block.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string")
    return { ok: false, error: "Expected {type:'image', data:base64, mimeType}." };
  if (!Object.values(MIME_BY_EXT).includes(block.mimeType))
    return { ok: false, error: "Unsupported inline image MIME type; use PNG, JPEG, GIF, or WebP." };
  if (block.data.length > Math.ceil(VISION_MAX_IMAGE_BYTES / 3) * 4)
    return { ok: false, error: "Inline image exceeds the 5 MB image size cap." };
  if (!block.data || block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data))
    return { ok: false, error: "Inline image data must be non-empty canonical base64." };
  const bytes = Buffer.from(block.data, "base64");
  if (bytes.length > VISION_MAX_IMAGE_BYTES)
    return { ok: false, error: "Inline image exceeds the 5 MB image size cap." };
  if (bytes.toString("base64") !== block.data)
    return { ok: false, error: "Inline image data must be canonical base64." };
  return { ok: true, image: { type: "image", data: block.data, mimeType: block.mimeType } };
}

export function validateWaiVisionParams(
  raw: unknown,
): { ok: false; error: string } | { ok: true; params: YooVisionParams } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid parameters: expected an object." };
  }
  const r = raw as Record<string, unknown>;
  if (r.path !== undefined && r.image !== undefined)
    return { ok: false, error: "Choose either path or image, not both." };
  const params: YooVisionParams = {};
  if (r.image !== undefined) {
    const inline = validateInlineImage(r.image);
    if (!inline.ok) return inline;
    params.image = inline.image;
  } else {
    if (typeof r.path !== "string" || r.path.length === 0)
      return { ok: false, error: "Missing or empty 'path' parameter; alternatively provide an inline image block." };
    params.path = r.path;
  }
  if (typeof r.question === "string" && r.question.length > 0) {
    params.question = r.question;
  }
  if (typeof r.context === "string" && r.context.length > 0) {
    params.context = r.context;
  }
  return { ok: true, params };
}

/** Resolve a vision input path. Relative paths must stay inside the project
 *  (path-traversal guard); absolute paths are allowed because the extension
 *  whitelist (images + .pdf), size caps, and the caller's explicit intent bound
 *  what can leave the machine — reading Downloads/Desktop media directly beats
 *  copying files into the project tree (which would pollute git status/diffs). */
export function resolveVisionPath(cwd: string, path: string): string | null {
  if (!path || path.includes("\0")) return null;
  if (isAbsolute(path)) {
    return normalize(path);
  }
  return resolveProjectPath(cwd, path);
}

/** Resolve and validate the image file: supported type, size cap. */
export function loadVisionImage(
  cwd: string,
  path: string,
): { ok: false; error: string } | { ok: true; data: string; mimeType: string } {
  const safePath = resolveVisionPath(cwd, path);
  if (!safePath) {
    return { ok: false, error: `Invalid image path "${path}": use a project-relative or absolute path to an image.` };
  }
  const mimeType = imageMimeType(safePath);
  if (!mimeType) {
    return {
      ok: false,
      error: `Unsupported image type "${extname(path)}". Supported: ${Object.keys(MIME_BY_EXT).join(", ")}.`,
    };
  }
  if (!existsSync(safePath)) {
    return { ok: false, error: `Image not found: ${path}` };
  }
  let size: number;
  try {
    size = statSync(safePath).size;
  } catch {
    return { ok: false, error: `Cannot read image: ${path}` };
  }
  if (size > VISION_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `Image too large: ${(size / 1024 / 1024).toFixed(1)} MB (max ${VISION_MAX_IMAGE_BYTES / 1024 / 1024} MB).`,
    };
  }
  try {
    return { ok: true, data: readFileSync(safePath).toString("base64"), mimeType };
  } catch {
    return { ok: false, error: `Cannot read image: ${path}` };
  }
}

type MupdfModule = typeof import("mupdf");

let mupdfPromise: Promise<MupdfModule> | undefined;

/** Lazy-load the mupdf WASM module (pure WASM, no native build). Cached after first use. */
async function getMupdf(): Promise<MupdfModule> {
  mupdfPromise ??= import("mupdf");
  return mupdfPromise;
}

export type VisionInput =
  { kind: "image"; images: VisionImage[]; mimeType: string } | { kind: "text"; text: string; pages: number };

/** Extract the text layer of a PDF; returns "" for scanned/image-only documents. */
async function extractPdfText(doc: import("mupdf").Document, pageCount: number): Promise<string> {
  const pagesToRead = Math.min(pageCount, VISION_MAX_PDF_TEXT_PAGES);
  const parts: string[] = [];
  for (let i = 0; i < pagesToRead; i++) {
    const page = doc.loadPage(i);
    try {
      const st = page.toStructuredText("");
      try {
        parts.push(st.asText());
      } finally {
        st.destroy();
      }
    } finally {
      page.destroy();
    }
    if (parts.join("").length > VISION_MAX_PDF_TEXT_CHARS) break;
  }
  return parts.join("\n").slice(0, VISION_MAX_PDF_TEXT_CHARS).trim();
}

/** Load a PDF: text layer when present (cheaper, exact), rendered page images
 *  when scanned. Rendering is capped at VISION_MAX_PDF_RENDER_PAGES pages. */
export async function loadVisionPdf(
  cwd: string,
  path: string,
): Promise<{ ok: false; error: string } | { ok: true; input: VisionInput }> {
  const safePath = resolveVisionPath(cwd, path);
  if (!safePath) {
    return { ok: false, error: `Invalid PDF path "${path}": use a project-relative or absolute path to a PDF.` };
  }
  if (!existsSync(safePath)) {
    return { ok: false, error: `PDF not found: ${path}` };
  }
  let size: number;
  try {
    size = statSync(safePath).size;
  } catch {
    return { ok: false, error: `Cannot read PDF: ${path}` };
  }
  if (size > VISION_MAX_PDF_BYTES) {
    return {
      ok: false,
      error: `PDF too large: ${(size / 1024 / 1024).toFixed(1)} MB (max ${VISION_MAX_PDF_BYTES / 1024 / 1024} MB).`,
    };
  }

  let mupdf: MupdfModule;
  try {
    mupdf = await getMupdf();
  } catch (err) {
    return {
      ok: false,
      error: `PDF support failed to load (mupdf): ${err instanceof Error ? err.message : String(err)}.`,
    };
  }

  let doc: import("mupdf").Document;
  try {
    doc = mupdf.Document.openDocument(readFileSync(safePath), "application/pdf");
  } catch (err) {
    return { ok: false, error: `Cannot parse PDF "${path}": ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const pageCount = doc.countPages();
    if (pageCount < 1) {
      return { ok: false, error: `PDF "${path}" has no pages.` };
    }

    const text = await extractPdfText(doc, pageCount);
    if (text.length >= VISION_PDF_MIN_TEXT_CHARS) {
      return { ok: true, input: { kind: "text", text, pages: pageCount } };
    }

    // Scanned/image-only PDF: render pages and let the vision model read them.
    const images: VisionImage[] = [];
    const pagesToRender = Math.min(pageCount, VISION_MAX_PDF_RENDER_PAGES);
    for (let i = 0; i < pagesToRender; i++) {
      const page = doc.loadPage(i);
      try {
        const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, true, true);
        try {
          const png = pixmap.asPNG();
          if (png.byteLength > VISION_MAX_IMAGE_BYTES) {
            return {
              ok: false,
              error: `Rendered PDF page ${i + 1} exceeds the image size cap; export it as an image manually instead.`,
            };
          }
          images.push({ data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    if (images.length === 0) {
      return { ok: false, error: `PDF "${path}" has no extractable text and no renderable pages.` };
    }
    return { ok: true, input: { kind: "image", images, mimeType: "application/pdf" } };
  } finally {
    doc.destroy();
  }
}

/** Load any supported vision input: an image file or a PDF (text layer first,
 *  rendered pages for scanned documents). */
export async function loadVisionInput(
  cwd: string,
  path: string,
): Promise<{ ok: false; error: string } | { ok: true; input: VisionInput }> {
  if (extname(path).toLowerCase() === ".pdf") {
    return loadVisionPdf(cwd, path);
  }
  const image = loadVisionImage(cwd, path);
  if (!image.ok) return image;
  return {
    ok: true,
    input: { kind: "image", images: [{ data: image.data, mimeType: image.mimeType }], mimeType: image.mimeType },
  };
}

export async function executeWaiVision(
  cwd: string,
  params: YooVisionParams,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: {
    getHeader(): unknown;
    getBranch(): unknown[];
  },
): Promise<{ result: VisionResult; cost: UsageCost; model: StageProfile } | { error: string }> {
  signal?.throwIfAborted();
  const validated = validateWaiVisionParams(params);
  if (!validated.ok) return { error: validated.error };
  params = validated.params;
  const config = loadYoowaiConfig(cwd);
  const modelConfig = resolveTaskModel(config, "vision");
  if (!modelConfig.provider || !modelConfig.id) {
    return { error: "No secondary model configured. Set pi-yoowai.secondary in settings.json." };
  }

  progress(1, 3, "Loading input…");
  const label = params.path ?? "inline image";
  const loaded = params.image
    ? {
        ok: true as const,
        input: {
          kind: "image" as const,
          images: [{ data: params.image.data, mimeType: params.image.mimeType }],
          mimeType: params.image.mimeType,
        },
      }
    : await loadVisionInput(cwd, params.path!);
  if (!loaded.ok) {
    return { error: loaded.error };
  }
  const { input } = loaded;

  progress(2, 3, `Calling ${modelConfig.provider}:${modelConfig.id}…`);
  // Only the text-call path (text-layer PDFs) carries the vision.md
  // instructions: image calls ride the image-content payload where injecting
  // developer text into the system prompt is not supported.
  const instructionsText =
    input.kind === "text" ? capActionInstructions(cwd, "vision", config.instructionsMaxTokens ?? 800) : "";
  const { system, user } =
    input.kind === "text"
      ? buildPdfAnalysisPrompt(label, input.text, input.pages, params.question, params.context, instructionsText)
      : buildVisionPrompt(label, params.question, params.context);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "vision",
    // Text-layer PDFs are a plain text call — no vision-capable model required.
    images: input.kind === "image" ? input.images : undefined,
    onStreamProgress: createStreamProgressCallback(progress, 2, 3),
  });

  const cost = recordCost(cwd, usage, config.costBudgetUsd);
  const model = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  const resultMimeType = input.kind === "text" ? "application/pdf" : input.mimeType;
  logEvent(cwd, "info", "Vision analysis completed", {
    path: label,
    inputKind: input.kind,
    mimeType: resultMimeType,
    provider: modelConfig.provider,
    model: modelConfig.id,
  });

  progress(3, 3, "Vision analysis complete");
  return {
    result: {
      summary: raw.slice(0, 500).trim(),
      details: raw.trim(),
      imagePath: label,
      mimeType: resultMimeType,
    },
    cost,
    model,
  };
}
