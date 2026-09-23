/**
 * HTML → markdown / plain text conversion for the webfetch tool.
 *
 * Two shapes are needed because they cost the model different amounts:
 * markdown keeps structure and links (the default), text drops the markup
 * entirely for pages where only the prose matters.
 */

import { Parser } from "htmlparser2";
import TurndownService from "turndown";

/** Elements whose text is noise in any format. */
const DROPPED = new Set(["script", "style", "noscript", "iframe", "object", "embed", "svg", "form", "template"]);

/** Elements that imply a line break once their content ends. */
const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "nav",
  "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote", "pre", "br", "hr", "dd", "dt",
]);

let service: TurndownService | undefined;

function turndown(): TurndownService {
  if (!service) {
    service = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    service.remove((node) => DROPPED.has(node.nodeName.toLowerCase()));
  }
  return service;
}

export function htmlToMarkdown(html: string): string {
  return turndown().turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html: string): string {
  let text = "";
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || DROPPED.has(name)) skipDepth += 1;
    },
    ontext(input) {
      if (skipDepth === 0) text += input;
    },
    onclosetag(name) {
      if (skipDepth > 0) {
        skipDepth -= 1;
        return;
      }
      if (BLOCK.has(name)) text += "\n";
    },
  });
  parser.write(html);
  parser.end();
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the content type describes an HTML document. */
export function isHtmlContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "text/html" || mime === "application/xhtml+xml";
}
