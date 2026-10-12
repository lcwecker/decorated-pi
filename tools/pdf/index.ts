/**
 * pdf tools — `read_pdf`, the model-callable entry point for PDF documents.
 *
 * This tool is the discoverable surface for pdf core: its schema declares the
 * `pages` window, and its description carries the rules Claude Code puts in its
 * own read tool description — a whole read stops at ten pages, a longer
 * document must be read in ranges, twenty pages per call. pi's `read` stays
 * pi's: its description and schema cannot be extended from an extension, and it
 * keeps returning raw bytes for a `.pdf` path, so the description here says so
 * and the guidelines repeat it.
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getPdfModelKey, parseModelKey } from "../../settings.js";
import { renderToolTextResult } from "../../utils/tool-output.js";
import {
  MAX_PDF_PAGES_PER_CALL,
  WHOLE_PDF_PAGE_LIMIT,
  expandHome,
  extractPdf,
  isPdfFile,
  pdfHeader,
} from "./core.js";

const readPdfParams = Type.Object({
  path: Type.String({ description: "Path to the PDF file (relative or absolute)" }),
  pages: Type.Optional(
    Type.String({
      description:
        `Page range to read, 1-indexed: "1-5", "3", or "10-20". At most ${MAX_PDF_PAGES_PER_CALL} pages per call. `
        + `Omit it for a PDF of ${WHOLE_PDF_PAGE_LIMIT} pages or fewer; a longer PDF needs it.`,
    }),
  ),
});

const readPdfDescription =
  `Read a PDF file's contents. Use this for .pdf paths — \`read\` returns their raw bytes. `
  + `A PDF of ${WHOLE_PDF_PAGE_LIMIT} pages or fewer is read whole. A longer PDF must be read in page `
  + `ranges: pass \`pages\` (for example pages: "1-5"); reading such a file without \`pages\` fails. `
  + `Pages are 1-indexed, at most ${MAX_PDF_PAGES_PER_CALL} pages are read per call, and the result states the `
  + `document's total page count, so a long document is read in consecutive windows.`;

/** The model a PDF read goes to: the one configured in /dp-model, else the
 *  session's active model — the rule image-vision follows. */
function resolveTargetModel(ctx: ExtensionContext): Model<any> | undefined {
  const pdfKey = getPdfModelKey();
  if (!pdfKey) return ctx.model;

  const parsed = parseModelKey(pdfKey);
  if (!parsed) throw new Error(`Invalid PDF model key: '${pdfKey}'`);
  const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model) throw new Error(`Configured PDF model '${pdfKey}' not found in registry.`);
  return model as Model<any>;
}

export function registerPdfReaderTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_pdf",
    label: "read_pdf",
    description: readPdfDescription,
    promptSnippet: "Read a PDF's text, or one page range of it",
    promptGuidelines: [
      "Use read_pdf for .pdf paths; read returns their raw bytes.",
      "For a PDF longer than 10 pages, pass pages (e.g. pages: \"1-10\") — a whole read of it fails.",
    ],
    parameters: readPdfParams,
    renderResult: renderToolTextResult,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const filePath = params.path;
      const absPath = resolve(ctx.cwd, expandHome(filePath));

      try {
        // A non-PDF path is refused here rather than handed to pdfinfo, whose
        // failure says nothing about what the caller actually asked for.
        if (!isPdfFile(absPath)) {
          throw new Error("it is not a PDF document (no %PDF- header).");
        }

        const model = resolveTargetModel(ctx);
        if (!model) {
          throw new Error("no model is available to read it with; configure one with /dp-model.");
        }

        const { text, pageCount, range, requested } = await extractPdf(
          model,
          absPath,
          ctx.modelRegistry,
          params.pages,
          signal,
        );
        const pages = range ? `${range.start}-${range.end}` : undefined;
        return {
          content: [{ type: "text" as const, text: `${pdfHeader(pageCount, range, requested)}\n\n${text}` }],
          details: { pdfModel: `${model.provider}/${model.id}`, pageCount, ...(pages ? { pages } : {}) },
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Cannot read PDF '${filePath}': ${message}` }],
          isError: true,
          details: {},
        };
      }
    },
  });
}
