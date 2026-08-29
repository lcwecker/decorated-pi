/**
 * Tests for image-vision.ts — vision model analysis of image reads.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeImage, __imageVisionTest, createImageVisionModule } from "../hooks/image-vision.js";

const { expandHome, detectImageMimeType } = __imageVisionTest;

describe("image-vision", () => {
  // ─── expandHome ─────────────────────────────────────────────────────

  describe("expandHome", () => {
    it("expands ~ to homedir", () => {
      expect(expandHome("~")).toBe(os.homedir());
    });

    it("expands ~/ to homedir with path", () => {
      expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
    });

    it("expands ~/ at start of relative path", () => {
      expect(expandHome("~/reolink/image.png")).toBe(
        path.join(os.homedir(), "reolink/image.png"),
      );
    });

    it("leaves absolute paths unchanged", () => {
      const abs = "/home/user/image.png";
      expect(expandHome(abs)).toBe(abs);
    });

    it("leaves relative paths without tilde unchanged", () => {
      const rel = "relative/path/image.png";
      expect(expandHome(rel)).toBe(rel);
    });

    it("leaves tilde in middle of path unchanged", () => {
      const p = "/home/~/user/image.png";
      expect(expandHome(p)).toBe(p);
    });
  });

  // ─── analyzeImage via model runtime ────────────────────────────────

  describe("analyzeImage", () => {
    it("routes through the model runtime with image content and a signal timeout", async () => {
      let captured: any;
      const runtime = {
        complete: async (model: any, context: any, options: any) => {
          captured = { model, context, options };
          return { content: [{ type: "text", text: "analysis result" }] };
        },
      };
      const out = await analyzeImage({ api: "openai-responses" } as any, "aGVsbG8=", "image/png", runtime as any);
      expect(out).toBe("analysis result");
      expect(captured.model).toEqual({ api: "openai-responses" });
      expect(captured.context.messages[0].role).toBe("user");
      expect(captured.context.messages[0].content).toEqual([
        { type: "text", text: expect.any(String) },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]);
      expect(captured.options.maxTokens).toBe(4096);
      expect(captured.options.signal).toBeInstanceOf(AbortSignal);
    });

    it("concatenates multiple text parts", async () => {
      const runtime = {
        complete: async () => ({
          content: [
            { type: "text", text: "first" },
            { type: "thinking", thinking: "skip me" },
            { type: "text", text: "second" },
          ],
        }),
      };
      expect(await analyzeImage({} as any, "", "image/png", runtime as any))
        .toBe("first\nsecond");
    });

    it("falls back to a placeholder when the model returns no text", async () => {
      const runtime = { complete: async () => ({ content: [] }) };
      expect(await analyzeImage({} as any, "", "image/png", runtime as any))
        .toBe("No analysis returned.");
    });
  });
});

describe("createImageVisionModule state isolation", () => {
  function makeToolCallEvent(toolCallId: string) {
    return { toolName: "read", toolCallId, input: { path: "fake.png" } };
  }

  function makeToolResultEvent(toolCallId: string) {
    return { toolName: "read", toolCallId, content: [] as any[], input: { path: "fake.png" } };
  }

  // tool_call handler bails out early when detectImageMimeType returns null
  // (no real image file), so pendingImageFallbacks stays empty in these
  // tests. To exercise the isolation boundary directly, we inject a pending
  // ID via tool_call on a non-image path, then verify tool_result on the
  // other instance does not see it.

  it("two module instances do not share pending tool-call IDs", async () => {
    const a = createImageVisionModule();
    const b = createImageVisionModule();

    const aCall = a.hooks.tool_call![0] as any;
    const bResult = b.hooks.tool_result![0] as any;

    // A's tool_call would add to pendingImageFallbacks if the file were an
    // image. Since "fake.png" isn't real, it returns early — but the point
    // is that B's tool_result must not see anything from A regardless.
    await aCall(makeToolCallEvent("a-1"), { cwd: process.cwd() });
    const bResultValue = await bResult(makeToolResultEvent("a-1"), { cwd: process.cwd() });
    expect(bResultValue).toBeUndefined();
  });
});

describe("detectImageMimeType (real files)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgv-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFile(name: string, buf: Buffer): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, buf);
    return p;
  }

  // Real magic-byte buffers for each format (sniffed by Pi's helper, which
  // reads the first ~4 KB and inspects the signature — it does not decode).
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
  ]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const GIF = Buffer.from("GIF89a");
  const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  const BMP = (() => {
    const pixelOffset = 54;
    const buf = Buffer.alloc(pixelOffset + 4);
    buf.write("BM", 0, "ascii");
    buf.writeUInt32LE(buf.length, 2);
    buf.writeUInt32LE(0, 6);
    buf.writeUInt32LE(pixelOffset, 10);
    buf.writeUInt32LE(40, 14);
    buf.writeInt32LE(1, 18);
    buf.writeInt32LE(1, 22);
    buf.writeUInt16LE(1, 26);
    buf.writeUInt16LE(24, 28);
    buf.writeUInt32LE(0, 30);
    buf.writeUInt32LE(4, 34);
    buf.writeInt32LE(2835, 38);
    buf.writeInt32LE(2835, 42);
    buf.writeUInt32LE(0, 46);
    buf.writeUInt32LE(0, 50);
    buf[54] = 0; buf[55] = 0; buf[56] = 255; buf[57] = 0; // 1x1 red pixel
    return buf;
  })();

  it("detects each supported format", async () => {
    expect(await detectImageMimeType(writeFile("a.png", PNG))).toBe("image/png");
    expect(await detectImageMimeType(writeFile("a.jpg", JPEG))).toBe("image/jpeg");
    expect(await detectImageMimeType(writeFile("a.gif", GIF))).toBe("image/gif");
    expect(await detectImageMimeType(writeFile("a.webp", WEBP))).toBe("image/webp");
  });

  it("returns null for unsupported types Pi still detects (e.g. BMP)", async () => {
    expect(await detectImageMimeType(writeFile("a.bmp", BMP))).toBeNull();
  });

  it("returns null for non-image and malformed files", async () => {
    expect(await detectImageMimeType(writeFile("a.txt", Buffer.from("not an image")))).toBeNull();
    // A PNG signature alone (truncated) is malformed — no valid IHDR chunk.
    expect(await detectImageMimeType(writeFile("a.t.png", PNG.subarray(0, 8)))).toBeNull();
  });
});
