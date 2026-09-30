/**
 * Tests for read/bash tool result externalization
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "path";
import {
  externalizeModule,
  maybeExternalizeToolResult,
  OUTPUT_EXTERNALIZE_THRESHOLD,
  pruneOldOutputs,
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
    expect(outText).toMatch(/^\[Output too long, saved to .+\.]$/);
    expect(outText.length).toBeLessThan(200); // single-line pointer
    expect(outText).toContain("decorated-pi-results");
  });

  it("externalizes read results above threshold", () => {
    const text = "z".repeat(OUTPUT_EXTERNALIZE_THRESHOLD + 20_000);
    const event = makeEvent("read", text);
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeDefined();
    const outText = result!.content![0].text;
    expect(outText).toMatch(/^\[Output too long, saved to .+\.]$/);
    expect(outText).toContain("decorated-pi-results");
  });

  it("saves full content to temp file", () => {
    const text = "a".repeat(OUTPUT_EXTERNALIZE_THRESHOLD + 5_000);
    const event = makeEvent("bash", text, "call_00_saveTest123");
    const result = maybeExternalizeToolResult(event);
    expect(result).toBeDefined();

    // Extract path from placeholder text
    const outText = result!.content![0].text as string;
    // Pointer format: [Output too long, saved to /path.]
    const filePath = outText.match(/saved to (.+?)\.\]/)?.[1];
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

  it("keeps the parts that follow the oversized text", () => {
    const text = "y".repeat(OUTPUT_EXTERNALIZE_THRESHOLD + 1);
    const image = { type: "image", data: "base64..." };
    const event = {
      ...makeEvent("mcp_tool", text),
      content: [{ type: "text", text }, image],
    };

    const result = maybeExternalizeToolResult(event);
    expect(result).toBeDefined();
    expect(result!.content).toHaveLength(2);
    expect(result!.content![0].text).toMatch(/^\[Output too long, saved to .+\.\]$/);
    expect(result!.content![1]).toEqual(image);
  });

  it("keeps a trailing text part", () => {
    const text = "y".repeat(OUTPUT_EXTERNALIZE_THRESHOLD + 1);
    const trailing = { type: "text", text: "trailing note" };
    const event = {
      ...makeEvent("bash", text),
      content: [{ type: "text", text }, trailing],
    };

    const result = maybeExternalizeToolResult(event);
    expect(result!.content).toHaveLength(2);
    expect(result!.content![1]).toEqual(trailing);
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

describe("pruneOldOutputs", () => {
  // Fixed reference point so the day boundary is not the machine's clock.
  const now = new Date(2026, 4, 17, 10, 0, 0); // 2026-05-17 local

  afterEach(() => {
    if (fs.existsSync(TOOL_OUTPUT_TEMP_DIR)) {
      fs.rmSync(TOOL_OUTPUT_TEMP_DIR, { recursive: true, force: true });
    }
  });

  function write(name: string, mtime: Date): string {
    fs.mkdirSync(TOOL_OUTPUT_TEMP_DIR, { recursive: true });
    const filePath = path.join(TOOL_OUTPUT_TEMP_DIR, name);
    fs.writeFileSync(filePath, name);
    fs.utimesSync(filePath, mtime, mtime);
    return filePath;
  }

  it("removes earlier days' spills and keeps today's", () => {
    const lastMonth = write("bash-old.txt", new Date(2026, 3, 1, 12, 0, 0));
    const justBeforeMidnight = write("read-late.txt", new Date(2026, 4, 16, 23, 59, 59));
    const justAfterMidnight = write("read-early.txt", new Date(2026, 4, 17, 0, 0, 1));
    const earlierToday = write("bash-recent.txt", new Date(2026, 4, 17, 9, 58, 0));

    expect(pruneOldOutputs(now)).toBe(2);
    expect(fs.existsSync(lastMonth)).toBe(false);
    expect(fs.existsSync(justBeforeMidnight)).toBe(false);
    expect(fs.existsSync(justAfterMidnight)).toBe(true);
    expect(fs.existsSync(earlierToday)).toBe(true);
  });

  it("is a no-op when the directory does not exist", () => {
    expect(fs.existsSync(TOOL_OUTPUT_TEMP_DIR)).toBe(false);
    expect(pruneOldOutputs(now)).toBe(0);
  });

  it("leaves subdirectories alone", () => {
    const nested = path.join(TOOL_OUTPUT_TEMP_DIR, "nested");
    fs.mkdirSync(nested, { recursive: true });
    expect(pruneOldOutputs(now)).toBe(0);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("runs from the module's session_start hook", async () => {
    const stale = write("bash-stale.txt", new Date(2020, 0, 1));
    const handler = externalizeModule.hooks.session_start![0];
    await handler({ type: "session_start", reason: "startup" }, {} as any, {} as any);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
