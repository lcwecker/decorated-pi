/**
 * Tests for image-vision.ts — vision model analysis of image reads.
 */

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { __imageVisionTest } from "../hooks/image-vision.js";

const { expandHome, appendCodexSseDelta, codexResponsesUrl, extractCodexAccountId } = __imageVisionTest;

function jwtWithPayload(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

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

  // ─── codex ─────────────────────────────────────────────────────────

  describe("codex helpers", () => {
    it("builds codex responses URL from backend base URL", () => {
      expect(codexResponsesUrl("https://chatgpt.com/backend-api")).toBe(
        "https://chatgpt.com/backend-api/codex/responses",
      );
    });

    it("does not duplicate codex responses path", () => {
      expect(codexResponsesUrl("https://chatgpt.com/backend-api/codex")).toBe(
        "https://chatgpt.com/backend-api/codex/responses",
      );
      expect(codexResponsesUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(
        "https://chatgpt.com/backend-api/codex/responses",
      );
    });

    it("extracts account id from JWT base64url payload", () => {
      const token = jwtWithPayload({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
      });
      expect(extractCodexAccountId(token)).toBe("acct_123");
    });

    it("returns empty account id for invalid token", () => {
      expect(extractCodexAccountId("not-a-jwt")).toBe("");
    });

    it("appends SSE output text delta", () => {
      const line = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`;
      expect(appendCodexSseDelta("", line)).toBe("hello");
      expect(appendCodexSseDelta("hello", "data: [DONE]")).toBe("hello");
    });
  });
});
