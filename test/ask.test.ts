/**
 * Ask tool tests — UI component input handling, wizard flow, and tool formatting.
 */

import { describe, it, expect } from "vitest";
import { AskComponent, type AskQuestion } from "../ui/ask.js";
import { formatAnswers } from "../tools/ask/index.js";

function mockTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

function mockTui() {
  return { requestRender: () => {} } as any;
}

describe("AskComponent — wizard flow", () => {
  it("text question: type, Enter commits → summary → Enter submits", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [{ id: "q", type: "text", question: "Name?" }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("h");
    comp.handleInput("i");
    comp.handleInput("\r"); // commit text, advance to summary
    expect(result).toBeUndefined();
    comp.handleInput("\r"); // submit on summary
    expect(result).toEqual([{ id: "q", value: "hi" }]);
  });

  it("text question: accepts full-width / CJK input", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [{ id: "q", type: "text", question: "Name?" }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    // The earlier ASCII-only filter (`>= " " && <= "~"`) rejected every
    // code point above U+007F, so typing Chinese silently dropped characters.
    comp.handleInput("你");
    comp.handleInput("好");
    comp.handleInput("，");
    comp.handleInput("世");
    comp.handleInput("界");
    comp.handleInput("\r");
    comp.handleInput("\r");
    expect(result).toEqual([{ id: "q", value: "你好，世界" }]);
  });

  it("Tab navigates forward without committing", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [
      { id: "a", type: "text", question: "A?" },
      { id: "b", type: "single", question: "B?", options: ["x", "y"] },
    ];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("\t"); // tab from a (empty) → b
    comp.handleInput("2"); // select y
    comp.handleInput("\r"); // commit b → summary
    comp.handleInput("\r"); // submit
    // a is still empty (Tab didn't commit, so its empty value is preserved)
    expect(result).toEqual([
      { id: "a", value: "" },
      { id: "b", value: "y" },
    ]);
  });

  it("Tab on last question wraps to first", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [
      { id: "a", type: "text", question: "A?" },
      { id: "b", type: "single", question: "B?", options: ["x"] },
    ];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("a"); // a = "a"
    comp.handleInput("\r"); // commit a → b
    comp.handleInput("\t"); // tab on b (last) → wraps to a (first)
    comp.handleInput("z"); // a = "az"
    comp.handleInput("\r"); // commit a → b
    comp.handleInput("\r"); // commit b → summary
    comp.handleInput("\r"); // submit
    expect(result).toEqual([
      { id: "a", value: "az" },
      { id: "b", value: "x" },
    ]);
  });

  it("Shift+Tab on first question wraps to last", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [
      { id: "a", type: "single", question: "A?", options: ["x"] },
      { id: "b", type: "text", question: "B?" },
    ];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("\x1b[Z"); // shift+tab on a (first) → wraps to b (last)
    comp.handleInput("y"); // b = "y"
    comp.handleInput("\r"); // commit b → summary (a is still default)
    comp.handleInput("\r"); // submit
    expect(result).toEqual([
      { id: "a", value: "x" },
      { id: "b", value: "y" },
    ]);
  });

  it("Shift+Tab goes back to previous question", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [
      { id: "first", type: "text", question: "First?" },
      { id: "second", type: "text", question: "Second?" },
    ];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("a"); // first = "a"
    comp.handleInput("\r"); // commit first, advance to second
    comp.handleInput("b"); // second = "b"
    comp.handleInput("\x1b[Z"); // shift+tab back to first
    comp.handleInput("A"); // first = "aA"
    comp.handleInput("\r"); // commit first
    comp.handleInput("\r"); // commit second
    comp.handleInput("\r"); // submit
    expect(result).toEqual([
      { id: "first", value: "aA" },
      { id: "second", value: "b" },
    ]);
  });

  it("single question: digit picks option, Enter commits", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [{ id: "q", type: "single", question: "Pick", options: ["x", "y", "z"] }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("3"); // select z
    comp.handleInput("\r"); // commit z
    comp.handleInput("\r"); // submit
    expect(result).toEqual([{ id: "q", value: "z" }]);
  });

  it("multi question: Space toggles, Enter commits → submit", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [{ id: "q", type: "multi", question: "Pick", options: ["x", "y", "z"] }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput(" "); // toggle x
    comp.handleInput("\x1b[B"); // down to y
    comp.handleInput(" "); // toggle y
    comp.handleInput("\r"); // commit [x, y]
    comp.handleInput("\r"); // submit
    expect(result).toEqual([{ id: "q", value: ["x", "y"] }]);
  });

  it("multi question: Enter refused when zero selected (stays on question)", () => {
    let result: any = "sentinel";
    const questions: AskQuestion[] = [{ id: "q", type: "multi", question: "Pick", options: ["x", "y"] }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("\r"); // refused
    expect(result).toBe("sentinel");
    comp.handleInput(" ");
    comp.handleInput("\r");
    comp.handleInput("\r");
    expect(result).toEqual([{ id: "q", value: ["x"] }]);
  });

  it("text question: Enter refused when empty (stays on question)", () => {
    let result: any = "sentinel";
    const questions: AskQuestion[] = [{ id: "q", type: "text", question: "Name?" }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("\r"); // refused
    expect(result).toBe("sentinel");
    comp.handleInput("a");
    comp.handleInput("\r");
    comp.handleInput("\r");
    expect(result).toEqual([{ id: "q", value: "a" }]);
  });

  it("Esc cancels from summary", () => {
    let result: any = "sentinel";
    const questions: AskQuestion[] = [{ id: "q", type: "text", question: "Name?" }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("a");
    comp.handleInput("\r");
    comp.handleInput("\x1b");
    expect(result).toBeUndefined();
  });

  it("Shift+Tab from summary returns to last question", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [
      { id: "first", type: "text", question: "First?" },
      { id: "second", type: "single", question: "Second?", options: ["a", "b"] },
    ];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("x");
    comp.handleInput("\r");
    comp.handleInput("\r");
    comp.handleInput("\x1b[Z");
    comp.handleInput("2");
    comp.handleInput("\r");
    comp.handleInput("\r");
    expect(result).toEqual([
      { id: "first", value: "x" },
      { id: "second", value: "b" },
    ]);
  });

  it("renders without throwing (regression: DynamicBorder was constructed with a color fn instead of theme)", () => {
    const theme = mockTheme();
    const questions: AskQuestion[] = [{ id: "q", type: "text", question: "Name?" }];
    const comp = new AskComponent(mockTui(), theme, questions, () => {});
    expect(() => comp.render(80)).not.toThrow();
  });

  it("renders summary without throwing", () => {
    const theme = mockTheme();
    const questions: AskQuestion[] = [
      { id: "a", type: "text", question: "A?" },
      { id: "b", type: "single", question: "B?", options: ["x"] },
    ];
    const comp = new AskComponent(mockTui(), theme, questions, () => {});
    comp.handleInput("hi");
    comp.handleInput("\r");
    comp.handleInput("\r");
    expect(() => comp.render(80)).not.toThrow();
  });

  it("multi and single use the same indicator style (●/○)", () => {
    const theme = mockTheme();
    const questions: AskQuestion[] = [
      { id: "s", type: "single", question: "Pick one", options: ["a", "b"] },
      { id: "m", type: "multi", question: "Pick many", options: ["x", "y", "z"] },
    ];
    const comp = new AskComponent(mockTui(), theme, questions, () => {});
    comp.handleInput("\r"); // commit s (default "a") → m
    comp.handleInput(" ");  // toggle x
    comp.handleInput("\x1b[B"); // move to y
    comp.handleInput(" "); // toggle y
    // Render while still on the multi question — options are visible.
    const out = comp.render(120).join("\n");
    // Both single (already passed) and multi lists render only the two glyphs.
    expect(out).toContain("●");
    expect(out).toContain("○");
    expect(out).not.toContain("☑");
    expect(out).not.toContain("☐");
  });

  it("single + allowCustom: select Other, type, commit", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [{
      id: "color",
      type: "single",
      question: "Color?",
      options: ["red", "green", "blue"],
      allowCustom: true,
    }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    // Cursor lands on "red" (index 0). Down twice → "blue". Down once → "Other".
    comp.handleInput("\x1b[B");
    comp.handleInput("\x1b[B");
    comp.handleInput("\x1b[B");
    comp.handleInput("t"); // type into Other
    comp.handleInput("e");
    comp.handleInput("a");
    comp.handleInput("\r"); // commit Other → summary
    comp.handleInput("\r"); // submit
    expect(result).toEqual([{ id: "color", value: "tea" }]);
  });

  it("single + allowCustom: typing only happens on Other row, not on regular options", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [{
      id: "color",
      type: "single",
      question: "Color?",
      options: ["red", "green"],
      allowCustom: true,
    }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    // Cursor on "red" (index 0). Type "x" — should be ignored on regular option.
    comp.handleInput("x");
    comp.handleInput("\r"); // commit red (default)
    comp.handleInput("\r"); // submit
    expect(result).toEqual([{ id: "color", value: "red" }]);
  });

  it("single + allowCustom: Enter on Other with empty text is invalid", () => {
    let result: any = "sentinel";
    const questions: AskQuestion[] = [{
      id: "color",
      type: "single",
      question: "Color?",
      options: ["red"],
      allowCustom: true,
    }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput("\x1b[B"); // cursor on Other (only "red" + "Other")
    comp.handleInput("\r"); // refused (empty customText)
    expect(result).toBe("sentinel");
    comp.handleInput("o"); // type
    comp.handleInput("k");
    comp.handleInput("\r"); // commit
    comp.handleInput("\r"); // submit
    expect(result).toEqual([{ id: "color", value: "ok" }]);
  });

  it("multi + allowCustom: toggle Other, type, commit", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [{
      id: "langs",
      type: "multi",
      question: "Languages?",
      options: ["TypeScript", "Python"],
      allowCustom: true,
    }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput(" "); // toggle TypeScript
    comp.handleInput("\x1b[B"); // down to Python
    comp.handleInput(" "); // toggle Python
    comp.handleInput("\x1b[B"); // down to Other
    comp.handleInput(" "); // toggle Other on
    comp.handleInput("r"); // type custom
    comp.handleInput("u");
    comp.handleInput("s");
    comp.handleInput("t");
    comp.handleInput("\r"); // commit → summary
    comp.handleInput("\r"); // submit
    expect(result).toEqual([{ id: "langs", value: ["TypeScript", "Python", "rust"] }]);
  });

  it("multi + allowCustom: toggling Other off drops the custom text from answer", () => {
    let result: any = undefined;
    const questions: AskQuestion[] = [{
      id: "langs",
      type: "multi",
      question: "Languages?",
      options: ["Python"],
      allowCustom: true,
    }];
    const comp = new AskComponent(mockTui(), mockTheme(), questions, (ans) => { result = ans; });
    comp.handleInput(" "); // toggle Python
    comp.handleInput("\x1b[B"); // down to Other
    comp.handleInput("r"); // auto-select Other, type "r"
    comp.handleInput("u");
    comp.handleInput("s");
    comp.handleInput(" "); // toggle Other off
    comp.handleInput("\r"); // commit → summary
    comp.handleInput("\r"); // submit
    expect(result).toEqual([{ id: "langs", value: ["Python"] }]);
  });
});

describe("formatAnswers", () => {
  it("formats text, single, and multi answers", () => {
    const questions: AskQuestion[] = [
      { id: "n", type: "text", question: "Name?" },
      { id: "c", type: "single", question: "Color?", options: ["red", "blue"] },
      { id: "f", type: "multi", question: "Features?", options: ["a", "b"] },
    ];
    const answers = [
      { id: "n", value: "Ray" },
      { id: "c", value: "red" },
      { id: "f", value: ["a", "b"] },
    ];
    expect(formatAnswers(questions, answers)).toBe("Name?: Ray\nColor?: red\nFeatures?: a, b");
  });
});