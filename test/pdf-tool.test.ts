/**
 * Tests for tools/pdf/index.ts — the `read_pdf` tool the model calls: its
 * declared surface and what one call does end to end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerPdfReaderTools } from "../tools/pdf/index.js";
import { setPdfModelKey } from "../settings.js";
import { agentDir } from "./agent-dir.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

/** What `pdfinfo` prints, trimmed to the two lines the tool reads. */
function mockBinaries({ pages = 2, encrypted = false } = {}): void {
  execFileSyncMock.mockImplementation((binary: string, args: string[]) => {
    // poppler is resolved through the dependency resolver, so the argument is an
    // absolute path on this machine.
    const name = binary.split("/").pop();
    if (name === "pdfinfo") {
      return `Title:           fixture\nPages:           ${pages}\nEncrypted:       ${encrypted ? "yes" : "no"}\n`;
    }
    if (name === "pdftoppm") {
      const prefix = args[args.length - 1];
      const start = Number(args[args.indexOf("-f") + 1]);
      const end = Number(args[args.indexOf("-l") + 1]);
      for (let page = start; page <= end; page++) fs.writeFileSync(`${prefix}-${page}.jpg`, `jpeg-${page}`);
      return "";
    }
    throw new Error(`unexpected binary: ${binary}`);
  });
}

function writePdf(name: string, body = "%PDF-1.7\ncontent"): string {
  const file = path.join(agentDir(), name);
  fs.writeFileSync(file, body);
  return file;
}

const activeModel = {
  id: "gemini-2.5-flash",
  provider: "gemini-ops",
  api: "openai-completions",
  input: ["text", "image"],
} as any;

function runtimeStub(overrides: Record<string, unknown> = {}): any {
  return {
    complete: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Extracted PDF contents: Chapter 1" }],
    }),
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "mock-key" }),
    find: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

/** Register the tool on a stub pi and hand back the definition it declared. */
function declaredTool(): any {
  let tool: any;
  registerPdfReaderTools({ registerTool: (definition: any) => { tool = definition; } } as any);
  return tool;
}

function ctxFor(runtime: any, model: any = activeModel): any {
  return { cwd: agentDir(), hasUI: false, model, modelRegistry: runtime };
}

async function readPdf(params: Record<string, unknown>, runtime: any, model: any = activeModel) {
  const tool = declaredTool();
  return tool.execute("call-1", params, undefined, undefined, ctxFor(runtime, model));
}

describe("read_pdf tool declaration", () => {
  it("declares the name, the page parameter and the rules the model needs", () => {
    const tool = declaredTool();

    expect(tool.name).toBe("read_pdf");
    expect(tool.description).toContain("`read` returns their raw bytes");
    expect(tool.description).toContain("must be read in page");
    expect(tool.description).toContain("10 pages or fewer is read whole");
    expect(tool.description).toContain("at most 20 pages");
    expect(tool.promptSnippet).toContain("PDF");
    expect(tool.promptGuidelines.join(" ")).toContain("read_pdf for .pdf paths");

    const pages = tool.parameters.properties.pages;
    expect(pages).toBeDefined();
    expect(pages.description).toContain('"1-5"');
    expect(pages.description).toContain("At most 20 pages");
    expect(tool.parameters.required).toEqual(["path"]);
  });
});

describe("read_pdf execution", () => {
  beforeEach(() => {
    setPdfModelKey(null);
    execFileSyncMock.mockReset();
    mockBinaries();
  });

  it("reads a short pdf whole and states its page count", async () => {
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("short.pdf") }, runtime);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("[PDF: 2 pages]");
    expect(result.content[0].text).toContain("Extracted PDF contents");
    expect(result.details).toMatchObject({ pdfModel: "gemini-ops/gemini-2.5-flash", pageCount: 2 });

    const content = runtime.complete.mock.calls[0][1].messages[0].content;
    expect(content[1].mimeType).toBe("application/pdf");
  });

  it("asks for a page range instead of sending a long pdf whole", async () => {
    mockBinaries({ pages: 42 });
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("long.pdf") }, runtime);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot read PDF");
    expect(result.content[0].text).toContain("42 pages");
    expect(result.content[0].text).toContain('pages: "1-10"');
    expect(runtime.complete).not.toHaveBeenCalled();
  });

  it("renders the requested pages and sends them as image blocks", async () => {
    mockBinaries({ pages: 12 });
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("window.pdf"), pages: "1-3" }, runtime);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("[PDF: 12 pages, showing pages 1-3]");
    expect(result.details).toMatchObject({ pageCount: 12, pages: "1-3" });

    const images = runtime.complete.mock.calls[0][1].messages[0].content.filter((part: any) => part.type === "image");
    expect(images).toHaveLength(3);
    expect(images.every((part: any) => part.mimeType === "image/jpeg")).toBe(true);
  });

  it("clamps a window to the per-call cap and says so in the header", async () => {
    mockBinaries({ pages: 42 });
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("clamped.pdf"), pages: "1-30" }, runtime);

    expect(result.content[0].text).toContain("showing pages 1-20");
    expect(result.content[0].text).toContain("requested 1-30");
    // one prompt block plus the twenty rendered pages
    expect(runtime.complete.mock.calls[0][1].messages[0].content).toHaveLength(21);
  });

  it("rejects a range that starts past the last page", async () => {
    mockBinaries({ pages: 12 });
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("past-end.pdf"), pages: "50-60" }, runtime);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("starts past the last page");
    expect(runtime.complete).not.toHaveBeenCalled();
  });

  it("teaches the accepted formats when the pages value is invalid", async () => {
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("invalid.pdf"), pages: "abc" }, runtime);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid pages parameter: "abc".');
    expect(result.content[0].text).toContain('Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.');
    expect(runtime.complete).not.toHaveBeenCalled();
  });

  it("treats an empty pages value as omitted", async () => {
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("empty-pages.pdf"), pages: "" }, runtime);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("[PDF: 2 pages]");
  });

  it("refuses an encrypted pdf with poppler's own wording", async () => {
    mockBinaries({ pages: 4, encrypted: true });
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("locked.pdf") }, runtime);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("password protected");
    expect(runtime.complete).not.toHaveBeenCalled();
  });

  it("refuses a path that is not a pdf before shelling out", async () => {
    const txt = path.join(agentDir(), "notes.txt");
    fs.writeFileSync(txt, "just text");
    const runtime = runtimeStub();
    const result = await readPdf({ path: txt }, runtime);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a PDF document");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("reports a model that cannot carry a pdf", async () => {
    const runtime = runtimeStub();
    const textOnly = { provider: "reolink", id: "deepseek-flash", api: "openai-completions", input: ["text"] } as any;
    const result = await readPdf({ path: writePdf("text-only.pdf") }, runtime, textOnly);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not support PDF document input");
  });

  it("says so when no model is available at all", async () => {
    const runtime = runtimeStub();
    // Built by hand: the default parameter above would swallow an explicit undefined.
    const result = await declaredTool().execute(
      "call-1",
      { path: writePdf("no-model.pdf") },
      undefined,
      undefined,
      { cwd: agentDir(), hasUI: false, model: undefined, modelRegistry: runtime },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no model is available");
  });

  it("prefers the model configured through /dp-model over the active one", async () => {
    setPdfModelKey("gemini-ops/gemini-3.8-flash-high");
    const configured = { ...activeModel, id: "gemini-3.8-flash-high" };
    const runtime = runtimeStub({ find: vi.fn().mockReturnValue(configured) });

    const result = await readPdf({ path: writePdf("configured.pdf") }, runtime);

    expect(result.details.pdfModel).toBe("gemini-ops/gemini-3.8-flash-high");
    expect(runtime.complete.mock.calls[0][0]).toBe(configured);
  });

  it("surfaces a provider failure as a failed result", async () => {
    const runtime = runtimeStub({
      complete: vi.fn().mockResolvedValue({ content: [], stopReason: "error", errorMessage: "401 Unauthorized" }),
    });
    const result = await readPdf({ path: writePdf("failing.pdf") }, runtime);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401 Unauthorized");
  });
});

describe("read_pdf with a model that cannot take the document", () => {
  const bedrock = { provider: "bedrock", id: "claude-3-7-sonnet", api: "bedrock-converse-stream", input: ["text", "image"] } as any;

  beforeEach(() => {
    setPdfModelKey(null);
    execFileSyncMock.mockReset();
    mockBinaries();
  });

  it("refuses the whole read and points at the page range", async () => {
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("bedrock.pdf") }, runtime, bedrock);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("read it in page ranges instead");
    expect(runtime.complete).not.toHaveBeenCalled();
  });

  it("still reads a page range as images", async () => {
    mockBinaries({ pages: 12 });
    const runtime = runtimeStub();
    const result = await readPdf({ path: writePdf("bedrock-pages.pdf"), pages: "1-2" }, runtime, bedrock);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("[PDF: 12 pages, showing pages 1-2]");
    const images = runtime.complete.mock.calls[0][1].messages[0].content.filter((part: any) => part.type === "image");
    expect(images).toHaveLength(2);
  });
});
