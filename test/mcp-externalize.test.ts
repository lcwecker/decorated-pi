/**
 * Tests for MCP large result externalization
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "path";
import {
  maybeExternalizeMcpResult,
  EXTERNALIZE_THRESHOLD,
  EXTERNALIZE_PREVIEW_SIZE,
} from "../extensions/mcp/builtin.js";

describe("maybeExternalizeMcpResult", () => {
  const tempDir = path.join(os.tmpdir(), "decorated-pi-results");

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns original content for small results", () => {
    const text = "small result";
    const result = maybeExternalizeMcpResult(text, "test-tool", "call-1");
    expect(result.content[0].text).toBe(text);
    expect(result.details).toEqual({});
  });

  it("returns original content at exactly threshold", () => {
    const text = "x".repeat(EXTERNALIZE_THRESHOLD);
    const result = maybeExternalizeMcpResult(text, "test-tool", "call-2");
    expect(result.content[0].text).toBe(text);
    expect(result.details).toEqual({});
  });

  it("externalizes content above threshold", () => {
    const text = "y".repeat(60_000);
    const result = maybeExternalizeMcpResult(text, "test-tool", "call-3");
    const outText = result.content[0].text;
    expect(outText).toContain("[Truncated: 60,000 chars total.");
    expect(outText).toContain("Full output saved to:");
    expect(outText.length).toBeLessThan(text.length);

    const filePath = (result.details as any).fullOutputPath;
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(text);
  });

  it("includes preview in externalized output", () => {
    const text = "z".repeat(60_000);
    const result = maybeExternalizeMcpResult(text, "test-tool", "call-4");
    const outText = result.content[0].text;
    expect(outText).toMatch(/^z{2000}/);
  });

  it("includes truncation metadata", () => {
    const text = "a".repeat(60_000);
    const result = maybeExternalizeMcpResult(text, "test-tool", "call-5");
    const truncation = (result.details as any).truncation;
    expect(truncation.truncated).toBe(true);
    expect(truncation.outputChars).toBe(EXTERNALIZE_PREVIEW_SIZE);
    expect(truncation.totalChars).toBe(60_000);
    expect(truncation.maxBytes).toBe(EXTERNALIZE_THRESHOLD);
  });
});
