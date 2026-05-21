/**
 * LSP type definitions — minimal set needed by this extension.
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

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: unknown;
  source?: string;
  message: string;
}

export interface LspHover {
  contents: unknown;
  range?: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  containerName?: string;
  detail?: string;
  children?: LspDocumentSymbol[];
  uri?: string;
}
