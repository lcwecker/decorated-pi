/**
 * AskComponent — multi-question user input UI.
 *
 * Wizard-style: one question per page, committed on Enter (or Tab).
 * After the last question is committed, shows a summary; Enter submits.
 * Esc at any time cancels.
 *
 * Per-question UX:
 *   text    — type to fill, Enter/Tab to commit & advance.
 *   single  — ↑↓/digits to pick, Enter/Tab to commit & advance.
 *             First option is pre-selected so Enter alone accepts the default.
 *   multi   — ↑↓ to move, Space/digits to toggle, Enter/Tab to commit & advance.
 *             Starts empty; committing with zero selections is refused.
 *
 * Navigation: Shift+Tab goes back to the previous question without
 * discarding edits to the current one (they stay on disk until you
 * commit them by advancing).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI, type Component, getKeybindings } from "@earendil-works/pi-tui";

export type AskQuestionType = "text" | "single" | "multi";

export interface AskQuestion {
  id: string;
  type: AskQuestionType;
  question: string;
  options?: string[];
  default?: string;
  /** When true on single/multi, an "Other" row is appended after the
   *  regular options. Picking it switches the row into an inline text
   *  input — lets the user type a custom answer not in the preset list. */
  allowCustom?: boolean;
}

export interface AskAnswer {
  id: string;
  value: string | string[];
}

interface QuestionState {
  value: string | string[];
  cursor: number; // option cursor; for allowCustom, opts.length = "Other" row
  /** Typed text when the cursor sits on the "Other" row (single or multi). */
  customText: string;
  /** Multi only: whether "Other" is currently toggled into the selection. */
  customSelected: boolean;
}

function parseDefault(type: AskQuestionType, options: string[] | undefined, defaultValue: string | undefined): QuestionState {
  if (type === "text") {
    return { value: defaultValue ?? "", cursor: 0, customText: "", customSelected: false };
  }
  const opts = options ?? [];
  if (type === "single") {
    const idx = defaultValue ? Math.max(0, opts.indexOf(defaultValue)) : 0;
    return { value: opts[idx] ?? "", cursor: idx, customText: "", customSelected: false };
  }
  // multi: comma-separated default, or empty
  const selected = defaultValue ? defaultValue.split(",").map(s => s.trim()).filter(Boolean) : [];
  return { value: selected, cursor: 0, customText: "", customSelected: false };
}

/** For single/multi with allowCustom, returns the effective option count
 *  (regular options plus the "Other" row). */
function effectiveOptionCount(q: AskQuestion): number {
  return (q.options?.length ?? 0) + (q.allowCustom ? 1 : 0);
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** Extract content from a bracketed-paste sequence. Returns undefined if the
 *  data is not a complete paste. Any trailing input after the end marker is
 *  returned as `remaining` so it can be processed recursively. */
function extractBracketedPaste(data: string): { content: string; remaining: string } | undefined {
  if (!data.startsWith(BRACKETED_PASTE_START)) return undefined;
  const afterStart = data.slice(BRACKETED_PASTE_START.length);
  const endIndex = afterStart.indexOf(BRACKETED_PASTE_END);
  if (endIndex === -1) return undefined;
  return {
    content: afterStart.slice(0, endIndex),
    remaining: afterStart.slice(endIndex + BRACKETED_PASTE_END.length),
  };
}

/** Normalize pasted text for a single-line input: strip line breaks and
 *  expand tabs to spaces (matches pi-tui's built-in Input behavior). */
function cleanPastedText(text: string): string {
  return text.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "    ");
}

class DynamicBorder implements Component {
  private colorFn: (str: string) => string;
  constructor(theme: Theme) { this.colorFn = (str: string) => theme.fg("border", str); }
  invalidate() {}
  render(width: number): string[] { return [this.colorFn("─".repeat(Math.max(1, width)))]; }
}

export class AskComponent extends Container {
  private theme: Theme;
  private tui: TUI;
  private questions: AskQuestion[];
  private states: Map<string, QuestionState>;
  private focusedIndex = 0;
  private summaryMode = false;
  private done: (answers?: AskAnswer[]) => void;

  private titleComponent: Text;
  private linesComponent: Text;
  private hintComponent: Text;

  constructor(tui: TUI, theme: Theme, questions: AskQuestion[], done: (answers?: AskAnswer[]) => void) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.questions = questions;
    this.done = done;

    this.states = new Map();
    for (const q of questions) {
      this.states.set(q.id, parseDefault(q.type, q.options, q.default));
    }

    this.addChild(new DynamicBorder(theme));
    this.addChild(new Spacer(1));

    this.titleComponent = new Text("", 1, 0);
    this.addChild(this.titleComponent);
    this.addChild(new Spacer(1));

    this.linesComponent = new Text("", 1, 0);
    this.addChild(this.linesComponent);
    this.addChild(new Spacer(1));

    this.hintComponent = new Text("", 1, 0);
    this.addChild(this.hintComponent);

    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(theme));

    this.renderView();
  }

  private currentQuestion(): AskQuestion {
    return this.questions[this.focusedIndex];
  }

  private currentState(): QuestionState {
    return this.states.get(this.currentQuestion().id)!;
  }

  private isCurrentValid(): boolean {
    const q = this.currentQuestion();
    const state = this.currentState();
    if (q.type === "text") return (state.value as string).trim() !== "";
    if (q.type === "single") {
      if (q.allowCustom && state.cursor === (q.options?.length ?? 0)) {
        return state.customText.trim() !== "";
      }
      return (state.value as string) !== "";
    }
    // multi: valid if any regular option is selected, or "Other" is
    // toggled AND has non-empty custom text.
    if (q.allowCustom && state.customSelected) {
      return state.customText.trim() !== "" || (state.value as string[]).length > 0;
    }
    return (state.value as string[]).length > 0;
  }

  /** The answer that will actually be submitted for this question. Differs
   *  from state.value when allowCustom is in play and "Other" is chosen. */
  private committedValue(q: AskQuestion, state: QuestionState): string | string[] {
    if (q.type === "single") {
      if (q.allowCustom && state.cursor === (q.options?.length ?? 0)) {
        return state.customText.trim();
      }
      return state.value as string;
    }
    if (q.type === "multi") {
      const base = state.value as string[];
      if (q.allowCustom && state.customSelected && state.customText.trim() !== "") {
        return [...base, state.customText.trim()];
      }
      return base;
    }
    return state.value;
  }

  private goToQuestion(index: number): void {
    this.focusedIndex = Math.max(0, Math.min(index, this.questions.length - 1));
    this.summaryMode = false;
    this.renderView();
  }

  /** Tab forward: wrap last → first so the user can cycle through questions
   *  freely without committing. Summary is reached only via Enter. */
  private cycleNext(): void {
    this.goToQuestion((this.focusedIndex + 1) % this.questions.length);
  }

  /** Shift+Tab backward: wrap first → last. */
  private cyclePrev(): void {
    this.goToQuestion((this.focusedIndex - 1 + this.questions.length) % this.questions.length);
  }

  private showSummary(): void {
    this.summaryMode = true;
    this.renderView();
  }

  /** Commit current question. Returns true if accepted (advanced or showed summary). */
  private commitCurrent(): boolean {
    if (!this.isCurrentValid()) return false;
    if (this.focusedIndex >= this.questions.length - 1) {
      this.showSummary();
    } else {
      this.goToQuestion(this.focusedIndex + 1);
    }
    return true;
  }

  private submit(): void {
    const answers: AskAnswer[] = this.questions.map(q => ({
      id: q.id,
      value: this.committedValue(q, this.states.get(q.id)!),
    }));
    this.done(answers);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    // ── Bracketed paste ─────────────────────────────────────────────
    // Terminals that support bracketed paste mode wrap pasted content in
    // \x1b[200~ ... \x1b[201~. Without handling this, the leading ESC is
    // rejected as a control character and nothing is inserted.
    const paste = extractBracketedPaste(data);
    if (paste) {
      if (!this.summaryMode) {
        const text = cleanPastedText(paste.content);
        const q = this.currentQuestion();
        const state = this.currentState();
        if (q.type === "text") {
          state.value = (state.value as string) + text;
        } else if (q.allowCustom) {
          const opts = q.options ?? [];
          if (state.cursor === opts.length) {
            state.customText += text;
            if (q.type === "multi") {
              state.customSelected = true;
            }
          }
        }
        this.renderView();
      }
      if (paste.remaining) {
        this.handleInput(paste.remaining);
      }
      return;
    }

    // ── Summary mode ────────────────────────────────────────────────
    if (this.summaryMode) {
      if (data === "\r" || data === "\n" || kb.matches(data, "tui.select.confirm")) {
        this.submit();
        return;
      }
      if (data === "\x1b" || data === "escape" || kb.matches(data, "tui.select.cancel")) {
        this.done(undefined);
        return;
      }
      if (data === "shift_tab" || data === "\x1b[Z") {
        this.goToQuestion(this.questions.length - 1);
        return;
      }
      return; // swallow everything else in summary
    }

    // ── Global wizard navigation ────────────────────────────────────
    if (data === "\x1b" || data === "escape" || kb.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (data === "shift_tab" || data === "\x1b[Z") {
      this.cyclePrev();
      return;
    }
    // Tab navigates forward without committing — lets the user peek
    // at later questions or skip back via Shift+Tab to fix earlier ones.
    if (data === "\t" || data === "tab") {
      this.cycleNext();
      return;
    }
    // Enter commits the current question and advances. Refused if
    // invalid (empty text or multi with zero selections).
    if (data === "\r" || data === "\n" || kb.matches(data, "tui.select.confirm")) {
      this.commitCurrent();
      return;
    }

    // ── Per-question input ──────────────────────────────────────────
    const q = this.currentQuestion();
    const state = this.currentState();

    if (q.type === "text") {
      if (data === "\x7f" || data === "backspace") {
        state.value = (state.value as string).slice(0, -1);
      } else if (data.length > 0 && data.charCodeAt(0) >= 0x20) {
        // Accept any printable character: ASCII, Latin-1, CJK, emoji
        // surrogate pairs. The earlier `>= " " && <= "~"` filter
        // rejected every code point above U+007F (i.e. all Chinese).
        state.value = (state.value as string) + data;
      }
    } else if (q.type === "single" && q.options) {
      const opts = q.options;
      const totalLen = effectiveOptionCount(q);
      const onCustomRow = q.allowCustom === true && state.cursor === opts.length;

      if (kb.matches(data, "tui.select.up")) {
        const next = (state.cursor - 1 + totalLen) % totalLen;
        state.cursor = next;
        state.value = next < opts.length ? opts[next] : "";
      } else if (kb.matches(data, "tui.select.down")) {
        const next = (state.cursor + 1) % totalLen;
        state.cursor = next;
        state.value = next < opts.length ? opts[next] : "";
      } else if (data >= "1" && data <= "9") {
        const idx = parseInt(data, 10) - 1;
        if (idx < totalLen) {
          state.cursor = idx;
          state.value = idx < opts.length ? opts[idx] : "";
        }
      } else if (onCustomRow) {
        if (data === "\x7f" || data === "backspace") {
          state.customText = state.customText.slice(0, -1);
        } else if (data.length > 0 && data.charCodeAt(0) >= 0x20) {
          state.customText += data;
        }
      }
    } else if (q.type === "multi" && q.options) {
      const opts = q.options;
      const totalLen = effectiveOptionCount(q);
      const onCustomRow = q.allowCustom === true && state.cursor === opts.length;

      if (kb.matches(data, "tui.select.up")) {
        state.cursor = (state.cursor - 1 + totalLen) % totalLen;
      } else if (kb.matches(data, "tui.select.down")) {
        state.cursor = (state.cursor + 1) % totalLen;
      } else if (data === " " || data === "space") {
        if (onCustomRow) {
          state.customSelected = !state.customSelected;
        } else {
          const selected = new Set(state.value as string[]);
          const opt = opts[state.cursor];
          if (selected.has(opt)) selected.delete(opt);
          else selected.add(opt);
          state.value = Array.from(selected);
        }
      } else if (data >= "1" && data <= "9") {
        const idx = parseInt(data, 10) - 1;
        if (idx < totalLen) {
          state.cursor = idx;
          if (idx < opts.length) {
            const selected = new Set(state.value as string[]);
            const opt = opts[idx];
            if (selected.has(opt)) selected.delete(opt);
            else selected.add(opt);
            state.value = Array.from(selected);
          }
        }
      } else if (onCustomRow && data.length > 0 && data.charCodeAt(0) >= 0x20) {
        // Typing on the "Other" row auto-selects it and feeds customText.
        // Backspace never enters this branch (handled below).
        if (data !== "\x7f" && data !== "backspace") {
          state.customSelected = true;
          state.customText += data;
        } else {
          state.customText = state.customText.slice(0, -1);
        }
      }
    }

    this.renderView();
  }

  private formatAnswer(q: AskQuestion, state: QuestionState): string {
    const value = this.committedValue(q, state);
    if (q.type === "multi") return (value as string[]).join(", ");
    return value as string;
  }

  private renderView(): void {
    if (this.summaryMode) {
      this.renderSummary();
    } else {
      this.renderQuestion();
    }
    this.tui.requestRender();
  }

  private renderQuestion(): void {
    const q = this.currentQuestion();
    const state = this.currentState();
    const title = this.theme.fg("accent", this.theme.bold("Ask")) +
                  this.theme.fg("dim", ` (${this.focusedIndex + 1}/${this.questions.length})`);
    this.titleComponent.setText(title);

    const lines: string[] = [];
    lines.push(q.question);
    lines.push("");

    if (q.type === "text") {
      const value = state.value as string;
      const cursor = this.theme.fg("accent", "_");
      lines.push(value + cursor);
    } else if (q.type === "single" && q.options) {
      const opts = q.options;
      const totalLen = effectiveOptionCount(q);
      for (let j = 0; j < totalLen; j++) {
        const isCustomRow = q.allowCustom === true && j === opts.length;
        const optLabel = isCustomRow ? "Other" : opts[j];
        const selected = isCustomRow ? false : optLabel === state.value;
        const atCursor = j === state.cursor;
        // "Other" row gets ● when focused (it's the chosen answer in the
        // sense that customText will be submitted); regular rows use the
        // value match.
        const icon = isCustomRow ? (atCursor ? "●" : "○") : (selected ? "●" : "○");
        let line: string;
        if (isCustomRow) {
          const text = state.customText;
          const cmark = atCursor ? "_" : "";
          line = `  ${icon} ${optLabel}: ${text}${cmark}`;
        } else {
          line = `  ${icon} ${optLabel}`;
        }
        lines.push(atCursor ? this.theme.fg("accent", line) : line);
      }
    } else if (q.type === "multi" && q.options) {
      const opts = q.options;
      const totalLen = effectiveOptionCount(q);
      for (let j = 0; j < totalLen; j++) {
        const isCustomRow = q.allowCustom === true && j === opts.length;
        const optLabel = isCustomRow ? "Other" : opts[j];
        const inValue = !isCustomRow && (state.value as string[]).includes(optLabel);
        const customOn = isCustomRow && state.customSelected;
        const atCursor = j === state.cursor;
        const icon = inValue || customOn ? "●" : "○";
        let line: string;
        if (isCustomRow) {
          const text = state.customText;
          const cmark = atCursor ? "_" : "";
          line = `  ${icon} ${optLabel}: ${text}${cmark}`;
        } else {
          line = `  ${icon} ${optLabel}`;
        }
        lines.push(atCursor ? this.theme.fg("accent", line) : line);
      }
    }

    this.linesComponent.setText(lines.join("\n"));

    let hint: string;
    if (q.type === "text") {
      hint = "Enter next · Esc cancel";
    } else if (q.type === "single") {
      hint = q.allowCustom
        ? "↑↓ move · Enter next · Esc cancel"
        : "↑↓ move · Enter next · Esc cancel";
    } else {
      hint = q.allowCustom
        ? "↑↓ move · Space toggle · Enter next · Esc cancel"
        : "↑↓ move · Space toggle · Enter next · Esc cancel";
    }
    this.hintComponent.setText(this.theme.fg("dim", "  " + hint));
  }

  private renderSummary(): void {
    this.titleComponent.setText(this.theme.fg("accent", this.theme.bold("Review")));

    const lines: string[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const state = this.states.get(q.id)!;
      const num = this.theme.fg("dim", `${i + 1}.`);
      lines.push(`${num} ${q.question}`);
      lines.push(`   ${this.formatAnswer(q, state)}`);
      if (i < this.questions.length - 1) lines.push("");
    }

    this.linesComponent.setText(lines.join("\n"));
    this.hintComponent.setText(this.theme.fg("dim", "  Enter submit · Shift+Tab back · Esc cancel"));
  }
}