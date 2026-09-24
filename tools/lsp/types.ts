/**
 * LSP type definitions — the subset this extension reads and writes.
 *
 * Positions are LSP-native: zero-based line and UTF-16 character offset. The
 * tools convert to and from the one-based pair a reader sees, so the model can
 * pass a number straight out of the `read` tool.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** One replacement: `newText` takes the place of `range`. */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** The two shapes `textDocument/rename` may answer with. */
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument?: { uri?: string }; edits?: LspTextEdit[] }>;
}

/** `textDocument/documentSymbol` hierarchical shape. */
export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

/** `textDocument/documentSymbol` flat shape, which some servers answer with. */
export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
}
