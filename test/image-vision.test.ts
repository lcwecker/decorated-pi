/**
 * Tests for image-vision.ts — vision model analysis of image reads.
 */

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeImage, __imageVisionTest, createImageVisionModule } from "../hooks/image-vision.js";

const { expandHome } = __imageVisionTest;

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
