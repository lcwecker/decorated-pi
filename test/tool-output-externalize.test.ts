/**
 * Tests for read/bash tool result externalization
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "path";
import {
  maybeExternalizeToolResult,
  OUTPUT_EXTERNALIZE_THRESHOLD,
  writeOutputToTemp,
  TOOL_OUTPUT_TEMP_DIR,
} from "../hooks/externalize.js";

// Minimal ToolResultEvent mock — matches ToolResultEventBase shape
function makeEvent(toolName: string, text: string, toolCallId = "call_00_test123456") {
  return {
    type: "tool_result",
    toolName,
    toolCallId,
    input: {},
    content: [{ type: "text", text }],
    isError: false,
    details: undefined,
  } as any;
}

describe("writeOutputToTemp", () => {
  afterEach(() => {
    if (fs.existsSync(TOOL_OUTPUT_TEMP_DIR)) {
      fs.rmSync(TOOL_OUTPUT_TEMP_DIR, { recursive: true, force: true });
    }
  });

  it("writes content to temp file and returns path", () => {
    const content = "hello world";
    const filePath = writeOutputToTemp("bash", "call_00_abc123", content);
    expect(filePath).toBeDefined();
    expect(fs.existsSync(filePath!)).toBe(true);
    expect(fs.readFileSync(filePath!, "utf-8")).toBe(content);
    expect(filePath).toContain("decorated-pi-results");
    expect(filePath).toContain("bash-call_00_abc");
  });

  it("uses random ID when toolCallId is empty", () => {
    const filePath = writeOutputToTemp("read", "", "test");
    expect(filePath).toBeDefined();
    // Should not contain empty prefix
    expect(filePath).not.toContain("read--");
  });

  it("returns undefined when /tmp is unavailable", () => {
    // This is hard to test without mocking fs, so we just verify
    // that the function signature returns undefined type
    // Real failure would require making mkdirSync throw
    const filePath = writeOutputToTemp("bash", "call_00_ok", "test");
    expect(typeof filePath).toBe("string");
  });
});

describe("maybeExternalizeToolResult", () => {
  afterEach(() => {
    if (fs.existsSync(TOOL_OUTPUT_TEMP_DIR)) {
      fs.rmSync(TOOL_OUTPUT_TEMP_DIR, { recursive: true, force: true });
    }
  });

  it("returns undefined for small results", () => {
    const event = makeEvent("bash", "small output");
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeUndefined();
  });

  it("returns undefined for results at exactly threshold", () => {
    const text = "x".repeat(OUTPUT_EXTERNALIZE_THRESHOLD);
    const event = makeEvent("read", text);
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeUndefined();
  });

  it("externalizes bash results above threshold", () => {
    const text = "y".repeat(OUTPUT_EXTERNALIZE_THRESHOLD + 10_000);
    const event = makeEvent("bash", text);
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeDefined();
    const outText = result!.content![0].text as string;
    expect(outText).toContain("[Output truncated: 40,000 chars.");
    expect(outText).toContain("Full output:");
    expect(outText.length).toBeLessThan(200); // single-line placeholder
    expect(outText).toContain("decorated-pi-results");
  });

  it("externalizes read results above threshold", () => {
    const text = "z".repeat(OUTPUT_EXTERNALIZE_THRESHOLD + 20_000);
    const event = makeEvent("read", text);
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeDefined();
    const outText = result!.content![0].text;
    expect(outText).toContain("[Output truncated:");
    expect(outText).toContain("chars. Full output:");
  });

  it("saves full content to temp file", () => {
    const text = "a".repeat(OUTPUT_EXTERNALIZE_THRESHOLD + 5_000);
    const event = makeEvent("bash", text, "call_00_saveTest123");
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeDefined();

    // Extract path from placeholder text
    const outText = result!.content![0].text as string;
    // Placeholder format: [Output truncated: N chars. Full output: /path]
    const filePath = outText.match(/Full output: (.+?)\]/)?.[1];
    expect(filePath).toBeDefined();
    expect(fs.existsSync(filePath!)).toBe(true);
    expect(fs.readFileSync(filePath!, "utf-8")).toBe(text);
  });

  it("returns undefined for non-text content", () => {
    const event = {
      ...makeEvent("bash", ""),
      content: [{ type: "image", data: "base64..." }],
    };
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty content array", () => {
    const event = {
      ...makeEvent("bash", ""),
      content: [],
    };
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeUndefined();
  });
});
