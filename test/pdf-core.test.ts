/**
 * Tests for tools/pdf/core.ts — PDF extraction through the model runtime and
 * the poppler-backed page helpers. The tool surface is covered by
 * test/pdf-tool.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  __pdfCoreTest,
  analyzePdfPagesWithModel,
  analyzePdfWithModel,
  parsePageRange,
} from "../tools/pdf/core.js";
import { agentDir } from "./agent-dir.js";

// The tool resolves poppler through settings.resolveDependency; mocking it lets
// a test prove the resolved path is what actually gets executed.
const resolveDependencyMock = vi.hoisted(() => vi.fn((_name: string): string | null => null));
vi.mock("../settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings.js")>();
  return { ...actual, resolveDependency: resolveDependencyMock };
});

const {
  expandHome,
  isPdfFile,
  supportsPdfInput,
  supportsPdfDocument,
  invalidPagesMessage,
  readPdfInfo,
  renderPageRange,
  pdfHeader,
} = __pdfCoreTest;

// The page path shells out to poppler. Both binaries are mocked so the tests
// describe what the module asks of them rather than depending on a host install.
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

/** What `pdfinfo` prints, trimmed to the two lines the module reads. */
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

/** A runtime stub — the real auth resolution is pi's, so the tests only assert
 *  what the module asks it for. */
function runtimeStub(overrides: Record<string, unknown> = {}): any {
  return {
    complete: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Extracted PDF contents: Chapter 1" }],
    }),
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "mock-key" }),
    ...overrides,
  };
}

const openAiModel = {
  id: "gemini-3.8-flash-high",
  provider: "gemini-ops",
  api: "openai-completions",
  input: ["text", "image"],
  baseUrl: "https://gemini.ops.reolink.cn/v1",
} as any;

describe("pdf core helpers", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    mockBinaries();
  });

  it("expands ~ to the home directory", () => {
    expect(expandHome("~")).toBe(require("node:os").homedir());
    expect(expandHome("~/a/b.pdf")).toBe(path.join(require("node:os").homedir(), "a/b.pdf"));
    expect(expandHome("/abs/a.pdf")).toBe("/abs/a.pdf");
  });

  it("identifies pdf files by their magic header", () => {
    expect(isPdfFile(writePdf("test.pdf"))).toBe(true);

    const txt = path.join(agentDir(), "test.txt");
    fs.writeFileSync(txt, "hello world");
    expect(isPdfFile(txt)).toBe(false);

    expect(isPdfFile(writePdf("fake.pdf", "not a pdf"))).toBe(false);
  });

  it("reports pdf support from the model's api and declared input", () => {
    expect(supportsPdfInput({ provider: "anthropic", id: "m", api: "anthropic-messages", input: ["text"] } as any)).toBe(true);
    expect(supportsPdfInput(openAiModel)).toBe(true);
    expect(supportsPdfInput({ provider: "reolink", id: "m", api: "openai-completions", input: ["text"] } as any)).toBe(false);
    expect(supportsPdfInput({ provider: "x", id: "m", api: "unknown" } as any)).toBe(false);
  });

  it("parses the documented page formats", () => {
    expect(parsePageRange("1-5")).toEqual({ start: 1, end: 5 });
    expect(parsePageRange("3")).toEqual({ start: 3, end: 3 });
    expect(parsePageRange("10-20")).toEqual({ start: 10, end: 20 });
    expect(parsePageRange(" 1 - 5 ")).toEqual({ start: 1, end: 5 });
    expect(parsePageRange(3)).toEqual({ start: 3, end: 3 });
  });

  it("rejects anything else", () => {
    for (const value of ["abc", "", "0", "5-3", "1-", "0-2", 1.5, 0, null, undefined, ["1"]]) {
      expect(parsePageRange(value)).toBeUndefined();
    }
  });

  it("prints the hint Claude Code's validator prints", () => {
    expect(invalidPagesMessage(""))
      .toBe('Invalid pages parameter: "". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.');
  });

  it("reads the page count and the encryption flag from pdfinfo", () => {
    mockBinaries({ pages: 7 });
    expect(readPdfInfo("/tmp/x.pdf")).toEqual({ pageCount: 7, encrypted: false });

    mockBinaries({ pages: 7, encrypted: true });
    expect(readPdfInfo("/tmp/x.pdf")).toEqual({ pageCount: 7, encrypted: true });
  });

  it("orders rendered pages numerically and removes its scratch directory", () => {
    // 10 has to follow 2: the sort is numeric, and lexicographic would put it after 1.
    const pages = renderPageRange("/tmp/x.pdf", { start: 1, end: 10 });
    expect(pages.map((page) => page.toString()))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((page) => `jpeg-${page}`));

    const args = execFileSyncMock.mock.calls.find((call: any[]) => call[0].endsWith("pdftoppm"))![1];
    expect(fs.existsSync(path.dirname(args[args.length - 1]))).toBe(false);
  });

  it("states the window in the result header", () => {
    expect(pdfHeader(2)).toBe("[PDF: 2 pages]");
    expect(pdfHeader(1)).toBe("[PDF: 1 page]");
    expect(pdfHeader(42, { start: 11, end: 15 })).toBe("[PDF: 42 pages, showing pages 11-15]");
    expect(pdfHeader(42, { start: 1, end: 20 }, { start: 1, end: 30 }))
      .toBe("[PDF: 42 pages, showing pages 1-20 (requested 1-30; 20 pages per call)]");
  });
});

describe("analyzePdfWithModel", () => {
  it("throws when the model cannot carry a pdf document", async () => {
    const textOnly = { provider: "reolink", id: "deepseek-flash", api: "openai-completions", input: ["text"] } as any;
    const runtime = runtimeStub();

    await expect(analyzePdfWithModel(textOnly, Buffer.from("%PDF-1.4"), runtime))
      .rejects.toThrow(/does not support PDF document input/);
    expect(runtime.complete).not.toHaveBeenCalled();
  });

  it("sends the pdf through the runtime as an application/pdf content block", async () => {
    const runtime = runtimeStub();
    const analysis = await analyzePdfWithModel(openAiModel, Buffer.from("%PDF-1.4 pdf bytes"), runtime);

    expect(analysis).toBe("Extracted PDF contents: Chapter 1");
    const [calledModel, context, options] = runtime.complete.mock.calls[0];
    expect(calledModel).toBe(openAiModel);
    expect(options.maxTokens).toBe(8192);
    expect(context.messages[0].content[1]).toEqual({
      type: "image",
      data: Buffer.from("%PDF-1.4 pdf bytes").toString("base64"),
      mimeType: "application/pdf",
    });
    // The runtime owns credentials — the module never resolves a key itself.
    expect(runtime.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("places the prompt before the document block so the model sees the instruction", async () => {
    const runtime = runtimeStub();
    await analyzePdfWithModel(openAiModel, Buffer.from("%PDF-1.4"), runtime, "Summarize this.");

    const content = runtime.complete.mock.calls[0][1].messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "Summarize this." });
    expect(content[1].type).toBe("image");
  });

  it("returns a placeholder when the model answers with no text", async () => {
    const runtime = runtimeStub({
      complete: vi.fn().mockResolvedValue({ content: [{ type: "thinking", text: "hmm" }] }),
    });
    await expect(analyzePdfWithModel(openAiModel, Buffer.from("%PDF-1.4"), runtime))
      .resolves.toBe("No text extracted from PDF.");
  });

  it("surfaces a provider failure instead of reporting an empty extraction", async () => {
    const runtime = runtimeStub({
      complete: vi.fn().mockResolvedValue({
        content: [],
        stopReason: "error",
        errorMessage: "Unknown image type: application/pdf",
      }),
    });
    // A provider that rejects the payload arrives as a resolved error message.
    await expect(analyzePdfWithModel(openAiModel, Buffer.from("%PDF-1.4"), runtime)).rejects.toThrow(
      /PDF analysis with 'gemini-ops\/gemini-3.8-flash-high' failed \(error\): Unknown image type: application\/pdf/,
    );
  });

  it("surfaces an aborted completion", async () => {
    const runtime = runtimeStub({
      complete: vi.fn().mockResolvedValue({ content: [], stopReason: "aborted" }),
    });
    await expect(analyzePdfWithModel(openAiModel, Buffer.from("%PDF-1.4"), runtime))
      .rejects.toThrow(/failed \(aborted\): the provider returned no error message/);
  });

  it("sends anthropic a native document block with runtime-resolved credentials", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Claude read the PDF" }] }),
    });
    globalThis.fetch = fetchMock as any;

    try {
      const runtime = runtimeStub({
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({
          ok: true,
          apiKey: "sk-ant-key",
          baseUrl: "https://gateway.example/anthropic/",
          headers: { "x-gateway-token": "gw", "x-drop-me": null },
        }),
      });
      const model = { provider: "anthropic", id: "claude-3-7-sonnet", api: "anthropic-messages", input: ["text", "image"] } as any;

      const analysis = await analyzePdfWithModel(model, Buffer.from("%PDF-1.7 doc"), runtime, "Read it.");

      expect(analysis).toBe("Claude read the PDF");
      expect(runtime.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
      expect(runtime.complete).not.toHaveBeenCalled();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://gateway.example/anthropic/v1/messages");
      expect(init.headers["x-api-key"]).toBe("sk-ant-key");
      expect(init.headers["x-gateway-token"]).toBe("gw");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");
      expect(Object.keys(init.headers)).not.toContain("x-drop-me");

      const body = JSON.parse(init.body);
      expect(body.model).toBe("claude-3-7-sonnet");
      expect(body.messages[0].content[0]).toEqual({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.7 doc").toString("base64") },
      });
      expect(body.messages[0].content[1]).toEqual({ type: "text", text: "Read it." });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces the runtime's credential error for anthropic", async () => {
    const runtime = runtimeStub({
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: false, error: "no api key for provider" }),
    });
    const model = { provider: "anthropic", id: "claude", api: "anthropic-messages" } as any;

    await expect(analyzePdfWithModel(model, Buffer.from("%PDF-1.4"), runtime)).rejects.toThrow(
      /No credentials for PDF model 'anthropic\/claude': no api key for provider/,
    );
  });
});

describe("pdf document capability", () => {
  const bedrock = { provider: "bedrock", id: "claude-3-7-sonnet", api: "bedrock-converse-stream", input: ["text", "image"] } as any;
  const textOnly = { provider: "reolink", id: "deepseek-flash", api: "openai-completions", input: ["text"] } as any;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    mockBinaries();
    resolveDependencyMock.mockImplementation(() => null);
  });

  it("separates the document path from the page-image path", () => {
    const anthropic = { provider: "anthropic", id: "claude", api: "anthropic-messages", input: ["text"] } as any;

    expect(supportsPdfDocument(anthropic)).toBe(true);
    expect(supportsPdfDocument(openAiModel)).toBe(true);
    // Bedrock's converter maps an image block to jpeg/png/gif/webp only.
    expect(supportsPdfDocument(bedrock)).toBe(false);
    expect(supportsPdfDocument(textOnly)).toBe(false);

    // Bedrock still reads page images, so only the whole-read path is closed.
    expect(supportsPdfInput(bedrock)).toBe(true);
    expect(supportsPdfInput(textOnly)).toBe(false);
  });

  it("points a model that cannot take the document at the page path", async () => {
    const runtime = runtimeStub();
    await expect(analyzePdfWithModel(bedrock, Buffer.from("%PDF-1.4"), runtime)).rejects.toThrow(
      /does not support PDF document input; read it in page ranges instead/,
    );
    expect(runtime.complete).not.toHaveBeenCalled();
  });

  it("renders pages for a model that cannot take the document", async () => {
    const runtime = runtimeStub();
    const analysis = await analyzePdfPagesWithModel(bedrock, [Buffer.from("jpeg")], runtime);

    expect(analysis).toBe("Extracted PDF contents: Chapter 1");
    const content = runtime.complete.mock.calls[0][1].messages[0].content;
    expect(content[1]).toEqual({ type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" });
  });

  it("runs the poppler path configured in /dp-settings", () => {
    resolveDependencyMock.mockImplementation((name: string) => `/opt/poppler/bin/${name}`);
    readPdfInfo("/tmp/x.pdf");

    expect(execFileSyncMock.mock.calls[0][0]).toBe("/opt/poppler/bin/pdfinfo");
  });

  it("falls back to the bare binary name when the resolver finds nothing", () => {
    mockBinaries({ pages: 3 });
    expect(readPdfInfo("/tmp/y.pdf")).toEqual({ pageCount: 3, encrypted: false });
    expect(execFileSyncMock.mock.calls[0][0]).toBe("pdfinfo");
  });
});
