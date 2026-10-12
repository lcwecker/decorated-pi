/**
 * pdf core — read a PDF with a vision model.
 *
 * A PDF of ten pages or fewer goes out whole, so the provider's own document
 * handling (text layer plus vision) applies: an Anthropic model receives a
 * native `document` block, every other API the `application/pdf` payload that
 * pi's converters already carry. A longer PDF is read in a page window —
 * `pdftoppm` renders those pages to JPEG and they travel as ordinary image
 * blocks, which every vision API accepts. `pdfinfo` supplies the page count and
 * the encryption flag.
 *
 * Requests go through pi's model runtime (`modelRegistry.complete`), the same
 * way image-vision does it, so authentication, baseUrl placeholders and
 * provider headers stay owned by the runtime. Anthropic's native `document`
 * block is the one shape pi-ai cannot produce — its converter hardcodes
 * `type: "image"` for every non-text block — so that path builds its own
 * request, with credentials still resolved by `getApiKeyAndHeaders`.
 *
 * A model that cannot carry a document raises an error; there is no fallback.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { resolveDependency } from "../../settings.js";

const PDF_MIME_TYPE = "application/pdf";
const ANTHROPIC_API = "anthropic-messages";
const ANTHROPIC_VERSION = "2023-06-01";
const BEDROCK_API = "bedrock-converse-stream";

const DEFAULT_PDF_PROMPT =
  "Please extract and analyze this PDF document thoroughly, preserving text, table structures, headings, code, and key findings.";

/** A PDF of this many pages or fewer is sent whole; beyond it `pages` is
 *  required. Both numbers mirror Claude Code's read tool. */
export const WHOLE_PDF_PAGE_LIMIT = 10;
export const MAX_PDF_PAGES_PER_CALL = 20;

/** Resolution `pdftoppm` renders a page at. Claude Code renders its page ranges
 *  with the same binary and does not document its resolution, so this one is
 *  measured: a dense page lands around 300–450 KB at 150 dpi, which keeps a
 *  twenty-page window inside both the 32 MB request cap and the 5 MB per-image
 *  cap, while 110 dpi starts to hurt small type. */
const RENDER_DPI = 150;

/** The two poppler binaries the page path needs. `pdfinfo` also answers the
 *  encryption question, which is what lets an encrypted file fail with a
 *  sentence instead of a provider error. */
export const PDF_INFO_BINARY = "pdfinfo";
export const PDF_RENDER_BINARY = "pdftoppm";

/** Runtime surface this module needs — the same two calls image-vision uses. */
type ModelRuntime = Pick<ModelRegistry, "complete" | "getApiKeyAndHeaders">;

export function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) return resolve(os.homedir(), filePath.slice(2));
  if (filePath === "~") return os.homedir();
  return filePath;
}

export function isPdfFile(filePath: string): boolean {
  if (!filePath.toLowerCase().endsWith(".pdf")) return false;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(5);
    const bytesRead = fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    return bytesRead >= 5 && buf.toString("ascii", 0, 5) === "%PDF-";
  } catch {
    return false;
  }
}

export interface PageRange {
  start: number;
  end: number;
}

/** Parse a `pages` value: `"1-5"`, `"3"` or `"10-20"`, 1-indexed. A bare
 *  number is accepted as well — models emit `pages: 3` often enough that
 *  rejecting it would cost a turn. Anything else returns undefined and the
 *  caller turns that into the format hint Claude Code's validator prints. */
export function parsePageRange(value: unknown): PageRange | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 ? { start: value, end: value } : undefined;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();

  const single = /^(\d+)$/.exec(text);
  if (single) {
    const page = Number(single[1]);
    return page >= 1 ? { start: page, end: page } : undefined;
  }

  const span = /^(\d+)\s*-\s*(\d+)$/.exec(text);
  if (!span) return undefined;
  const start = Number(span[1]);
  const end = Number(span[2]);
  if (start < 1 || end < start) return undefined;
  return { start, end };
}

export function invalidPagesMessage(value: unknown): string {
  return `Invalid pages parameter: ${JSON.stringify(String(value))}. `
    + "Use formats like \"1-5\", \"3\", or \"10-20\". Pages are 1-indexed.";
}

/** Poppler binaries go through the project's dependency resolver, so a path set
 *  in /dp-settings takes effect and the resolution is recorded for display. The
 *  bare name is the fallback, which leaves the lookup to PATH. */
function poppler(name: string): string {
  return resolveDependency(name) ?? name;
}

/** `pdfinfo` answers both questions the gate needs — the page count and whether
 *  the file is encrypted — from one process. An encrypted PDF may report no
 *  page count at all, so the caller reads `encrypted` first. */
export function readPdfInfo(filePath: string): { pageCount: number; encrypted: boolean } {
  const out = execFileSync(poppler(PDF_INFO_BINARY), [filePath], {
    encoding: "utf-8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const pages = /^Pages:\s+(\d+)/m.exec(out);
  return {
    pageCount: pages ? Number(pages[1]) : 0,
    encrypted: /^Encrypted:\s+yes/mi.test(out),
  };
}

/** Render a page window to JPEGs with poppler. The page number is the trailing
 *  integer of each output name (`page-007.jpg`), which is what orders the
 *  blocks; `-singlefile` is left out so one path covers a one-page window and a
 *  twenty-page one alike. */
export function renderPageRange(filePath: string, range: PageRange): Buffer[] {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "dp-pdf-"));
  try {
    execFileSync(poppler(PDF_RENDER_BINARY), [
      "-f", String(range.start),
      "-l", String(range.end),
      "-r", String(RENDER_DPI),
      "-jpeg", "-jpegopt", "quality=85",
      filePath,
      join(dir, "page"),
    ], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });

    const rendered = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".jpg"))
      .sort((a, b) => trailingNumber(a) - trailingNumber(b));
    if (rendered.length === 0) {
      throw new Error(`pdftoppm rendered no pages from '${filePath}'.`);
    }
    return rendered.map((name) => fs.readFileSync(join(dir, name)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function trailingNumber(name: string): number {
  const match = /(\d+)\.[^.]+$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The page count is not something an API hands the model, so every result
 *  states it. That line is what lets the next call pick a range that exists. */
export function pdfHeader(pageCount: number, range?: PageRange, requested?: PageRange): string {
  const pages = pageCount === 1 ? "1 page" : `${pageCount} pages`;
  if (!range) return `[PDF: ${pages}]`;

  const shown = `showing pages ${range.start}-${range.end}`;
  const clamped = requested && (requested.start !== range.start || requested.end !== range.end);
  if (!clamped) return `[PDF: ${pages}, ${shown}]`;
  return `[PDF: ${pages}, ${shown} (requested ${requested.start}-${requested.end}; `
    + `${MAX_PDF_PAGES_PER_CALL} pages per call)]`;
}

function modelLabel(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function isAnthropicMessages(model: Model<any>): boolean {
  return (model.api ?? "").toLowerCase() === ANTHROPIC_API;
}

function acceptsImages(model: Model<any>): boolean {
  const input = (model as { input?: unknown }).input;
  return Array.isArray(input) && input.includes("image");
}

/** Whether the model can receive the PDF document itself — the whole-read path.
 *  Anthropic takes a native `document` block. Bedrock's converter maps an image
 *  block to jpeg/png/gif/webp only and throws on `application/pdf`, so a Bedrock
 *  model is never handed the file; it can still read its pages as images. */
export function supportsPdfDocument(model: Model<any>): boolean {
  if (isAnthropicMessages(model)) return true;
  if ((model.api ?? "").toLowerCase() === BEDROCK_API) return false;
  return acceptsImages(model);
}

/** Whether the model accepts rendered page images — the page-window path. A
 *  model without image input has its block replaced by a placeholder by pi's
 *  own converter, so there is nothing to send. */
export function supportsPdfInput(model: Model<any>): boolean {
  return isAnthropicMessages(model) || acceptsImages(model);
}

/** Merge runtime-resolved headers, applying `null` values as deletions and
 *  keeping any header the caller already set. */
function mergeHeaders(
  base: Record<string, string>,
  resolved: Record<string, string | null> | undefined,
): Record<string, string> {
  const headers = { ...base };
  for (const [name, value] of Object.entries(resolved ?? {})) {
    const existing = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    if (value === null) {
      if (existing) delete headers[existing];
      continue;
    }
    if (existing) delete headers[existing];
    headers[name] = value;
  }
  return headers;
}

/** Anthropic native `document` block — the one shape pi-ai cannot produce. */
async function analyzePdfWithAnthropic(
  model: Model<any>,
  pdfBuffer: Buffer,
  runtime: ModelRuntime,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const auth = await runtime.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`No credentials for PDF model '${modelLabel(model)}': ${auth.error}`);
  }

  const headers = mergeHeaders({ "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION }, auth.headers);
  const hasAuthorization = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (auth.apiKey && !hasAuthorization) headers["x-api-key"] ??= auth.apiKey;

  const baseUrl = (auth.baseUrl ?? model.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.id,
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: PDF_MIME_TYPE, data: pdfBuffer.toString("base64") } },
          { type: "text", text: prompt },
        ],
      }],
    }),
    signal: signal ?? AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(`PDF request to '${modelLabel(model)}' failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  return text || "No text extracted from PDF.";
}

/** Extract a PDF with the given model. Auth, baseUrl and headers are resolved
 *  by the runtime on every call. */
export async function analyzePdfWithModel(
  model: Model<any>,
  pdfBuffer: Buffer,
  runtime: ModelRuntime,
  prompt = DEFAULT_PDF_PROMPT,
  signal?: AbortSignal,
): Promise<string> {
  if (!supportsPdfDocument(model)) {
    throw new Error(
      `Model '${modelLabel(model)}' does not support PDF document input; read it in page ranges instead (pass \`pages\`).`,
    );
  }

  if ((model.api ?? "").toLowerCase() === ANTHROPIC_API) {
    return analyzePdfWithAnthropic(model, pdfBuffer, runtime, prompt, signal);
  }

  const response = await runtime.complete(model, {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image", data: pdfBuffer.toString("base64"), mimeType: PDF_MIME_TYPE },
      ],
      timestamp: Date.now(),
    }],
  }, {
    maxTokens: 8192,
    signal: signal ?? AbortSignal.timeout(120_000),
  });

  return responseText(response, model);
}

/** Send rendered pages as image blocks — the one shape every vision API accepts,
 *  Anthropic included, which is why the page path needs no provider branch. */
export async function analyzePdfPagesWithModel(
  model: Model<any>,
  pages: Buffer[],
  runtime: ModelRuntime,
  prompt = DEFAULT_PDF_PROMPT,
  signal?: AbortSignal,
): Promise<string> {
  if (!supportsPdfInput(model)) {
    throw new Error(
      `Model '${modelLabel(model)}' does not accept image input, so its pages cannot be rendered for it.`,
    );
  }

  const response = await runtime.complete(model, {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...pages.map((page) => ({
          type: "image" as const,
          data: page.toString("base64"),
          mimeType: "image/jpeg",
        })),
      ],
      timestamp: Date.now(),
    }],
  }, {
    maxTokens: 8192,
    signal: signal ?? AbortSignal.timeout(120_000),
  });

  return responseText(response, model);
}

/** Shared tail of both paths. `complete()` resolves instead of rejecting when
 *  the provider fails: a rejected payload (Bedrock refuses `application/pdf`), a
 *  credential error and a timeout all arrive as an assistant message with
 *  `stopReason: "error"` or `"aborted"` plus an `errorMessage`. Reading only
 *  `content` would report every one of them as a successful "No text extracted
 *  from PDF." */
function responseText(response: AssistantMessage, model: Model<any>): string {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(
      `PDF analysis with '${modelLabel(model)}' failed (${response.stopReason}): `
      + (response.errorMessage ?? "the provider returned no error message"),
    );
  }

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || "No text extracted from PDF.";
}

/** Everything a caller needs to report one extraction: the text, the page count
 *  behind the header, and the window that was actually rendered. */
export interface PdfExtraction {
  text: string;
  pageCount: number;
  /** The window that was rendered, already clamped. */
  range?: PageRange;
  /** The window that was asked for, kept so a clamp can be reported. */
  requested?: PageRange;
}

/** Read a PDF with `model`: the whole document when it is short, otherwise the
 *  page window `pages` asks for. Throws a teaching message when the file cannot
 *  be read as asked — a long document without a range, a range that does not
 *  exist, an encrypted file, or a provider failure. */
export async function extractPdf(
  model: Model<any>,
  filePath: string,
  runtime: ModelRuntime,
  pages?: unknown,
  signal?: AbortSignal,
): Promise<PdfExtraction> {
  const { pageCount, encrypted } = readPdfInfo(filePath);
  if (encrypted) {
    throw new Error("it is password protected. Try using a CLI tool to extract or convert the PDF.");
  }

  // An empty string counts as left out: a client that serializes an unused
  // optional field that way would otherwise read as an invalid range.
  const raw = pages === "" ? undefined : pages;
  let requested: PageRange | undefined;
  if (raw !== undefined) {
    requested = parsePageRange(raw);
    if (!requested) throw new Error(invalidPagesMessage(raw));
  }

  if (requested) {
    const range = windowFor(requested, pageCount);
    const rendered = renderPageRange(filePath, range);
    return {
      text: await analyzePdfPagesWithModel(model, rendered, runtime, DEFAULT_PDF_PROMPT, signal),
      pageCount,
      range,
      requested,
    };
  }

  if (pageCount > WHOLE_PDF_PAGE_LIMIT) {
    throw new Error(wholeReadRefusal(filePath, pageCount));
  }

  return {
    text: await analyzePdfWithModel(model, fs.readFileSync(filePath), runtime, DEFAULT_PDF_PROMPT, signal),
    pageCount,
  };
}

/** The window actually rendered: clamped to the document and to the per-call
 *  cap, and rejected when its first page lies past the end. The caller compares
 *  it with what was asked for, so the header can report both. */
export function windowFor(requested: PageRange, pageCount: number): PageRange {
  if (requested.start > pageCount) {
    throw new Error(
      `page range ${requested.start}-${requested.end} starts past the last page (the document has ${pageCount}).`,
    );
  }
  return {
    start: requested.start,
    end: Math.min(requested.end, pageCount, requested.start + MAX_PDF_PAGES_PER_CALL - 1),
  };
}

/** The refusal that asks for a range. It carries the same two facts Claude
 *  Code's large-PDF reminder carries: the page count and the file size. */
function wholeReadRefusal(filePath: string, pageCount: number): string {
  const size = formatFileSize(fs.statSync(filePath).size);
  return `it has ${pageCount} pages (${size}), and PDFs longer than ${WHOLE_PDF_PAGE_LIMIT} pages are read in page ranges. `
    + `Pass the \`pages\` parameter, e.g. pages: "1-${WHOLE_PDF_PAGE_LIMIT}", or pages: "${WHOLE_PDF_PAGE_LIMIT + 1}-${Math.min(pageCount, WHOLE_PDF_PAGE_LIMIT + MAX_PDF_PAGES_PER_CALL)}". `
    + `At most ${MAX_PDF_PAGES_PER_CALL} pages are read per call.`;
}

export const __pdfCoreTest = {
  expandHome,
  isPdfFile,
  mergeHeaders,
  parsePageRange,
  invalidPagesMessage,
  readPdfInfo,
  renderPageRange,
  pdfHeader,
  formatFileSize,
  windowFor,
  supportsPdfInput,
  supportsPdfDocument,
};
