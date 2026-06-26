/**
 * Encoding detection and conversion for patch.
 *
 * - chardet analyses raw bytes (BOM + histogram heuristics) → encoding name.
 * - iconv-lite decodes/encodes between Buffer and string.
 *
 * For UTF-8 (the overwhelmingly common case) we bypass iconv-lite and use
 * Node's native string<->Buffer conversion — zero behaviour change vs the
 * pre-encoding-aware tool, and no iconv runtime cost for ASCII/UTF-8 files.
 */

import * as fs from "node:fs";
import chardet, { type Match } from "chardet";
import * as iconv from "iconv-lite";

export interface FileEncoding {
  /** iconv-lite-compatible encoding name (e.g. "utf-8", "gb18030", "utf-16le"). */
  encoding: string;
  /** True when the file starts with a BOM that should be preserved on write. */
  hasBOM: boolean;
  /** True when the file is UTF-8 (with or without BOM). Native path is used. */
  isUtf8: boolean;
}

// chardet emits "UTF-8" for plain UTF-8. iconv-lite accepts any case.
const UTF8_ALIASES = new Set(["utf-8", "utf8", "ascii"]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/** Returns true if `buf` is valid UTF-8 (every byte parses, no U+FFFD
 *  replacement). Pure-ASCII and any well-formed UTF-8 qualify. */
function isValidUtf8(buf: Buffer): boolean {
  // Writing then reading back would corrupt invalid sequences into U+FFFD;
  // detect that by comparing round-trip byte lengths. The cheap, correct
  // check is Node's built-in: toString('utf8') replaces bad sequences with
  // U+FFFD, so we scan the decoded string for it.
  if (buf.length === 0) return true;
  const s = buf.toString("utf8");
  return !s.includes("\uFFFD");
}

function looksLikeUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

function looksLikeUtf16LeBom(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
}

function looksLikeUtf16BeBom(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
}

/**
 * Detect a file's encoding by reading its bytes.
 * Falls back to UTF-8 if detection fails or the detected encoding is not
 * supported by iconv-lite.
 */
export function detectFileEncoding(filePath: string): FileEncoding {
  const buf = fs.readFileSync(filePath);

  // BOM takes precedence for the UTF-16/UTF-32 family (endianness matters).
  if (looksLikeUtf8Bom(buf)) {
    return { encoding: "utf-8", hasBOM: true, isUtf8: true };
  }
  if (looksLikeUtf16LeBom(buf)) {
    return { encoding: "utf-16le", hasBOM: true, isUtf8: false };
  }
  if (looksLikeUtf16BeBom(buf)) {
    return { encoding: "utf-16be", hasBOM: true, isUtf8: false };
  }

  // Any well-formed UTF-8 (including pure ASCII) is UTF-8. This short-circuits
  // chardet's tendency to mis-classify short or ASCII-only buffers as exotic
  // encodings (e.g. 2-byte "x\n" as utf-32le).
  if (isValidUtf8(buf)) {
    return { encoding: "utf-8", hasBOM: false, isUtf8: true };
  }

  // Not valid UTF-8 — trust chardet's heuristic for the legacy encoding.
  // chardet mis-classifies short or mixed CJK samples (it often ties GBK,
  // Big5, Shift_JIS, EUC-JP, EUC-KR at the same low confidence). Use the
  // full ranked list and prefer Chinese encodings — GB18030 is a superset
  // of GBK/GB2312 and the most common non-UTF-8 encoding for Chinese text,
  // which is the primary use case for this tool.
  const candidates = chardet.analyse(buf);
  let encoding = pickLegacyEncoding(candidates);
  let hasBOM = false;

  // Verify iconv-lite actually ships a codec for this label; otherwise fall
  // back to UTF-8 (the previous behaviour) instead of throwing mid-edit.
  if (!iconv.encodingExists(encoding)) {
    encoding = "utf-8";
    hasBOM = false;
  }

  // Last-resort safety net: if the chosen encoding still produces U+FFFD
  // replacement chars on decode, the file is not actually in that encoding
  // and we would corrupt it on write-back. Fall back to ISO-8859-1 (Latin1),
  // which is a lossless 1:1 byte<->code-point mapping for 0x00–0xFF and can
  // never introduce U+FFFD — round-tripping is byte-identical.
  if (!UTF8_ALIASES.has(encoding) && iconv.decode(buf, encoding).includes("\uFFFD")) {
    encoding = "iso-8859-1";
    hasBOM = false;
  }

  return {
    encoding,
    hasBOM,
    isUtf8: UTF8_ALIASES.has(encoding),
  };
}

/** Preference order for breaking chardet ties. Chinese first (GB18030 is a
 *  superset of GBK/GB2312), then other CJK, then everything else. */
const ENCODING_PRIORITY: string[] = [
  "gb18030", "gbk", "gb2312",  // Chinese (mainland)
  "big5",                       // Chinese (traditional)
  "shift_jis", "euc-jp",        // Japanese
  "euc-kr", "windows-949",      // Korean
  "windows-1252", "iso-8859-1", // Western (rarely reached: isValidUtf8 short-circuits)
];

function pickLegacyEncoding(candidates: Match[]): string {
  if (candidates.length === 0) return "iso-8859-1";
  const top = candidates[0]!.confidence;
  // Keep only candidates tied with the top confidence (±5 tolerance —
  // chardet's scores are coarse).
  const tied = candidates.filter((c) => Math.abs(c.confidence - top) <= 5);
  for (const pref of ENCODING_PRIORITY) {
    const hit = tied.find((c) => c.name.toLowerCase() === pref);
    if (hit) return pref;
  }
  // We only reach here when isValidUtf8 already failed (there are high
  // bytes), so "ascii" / "UTF-8" from chardet are wrong. ISO-8859-1 is the
  // safe single-byte fallback — lossless for 0x00–0xFF, no U+FFFD.
  return "iso-8859-1";
}

/** Read a file as a string, decoding via the detected encoding. */
export function readFileDecoded(filePath: string, enc: FileEncoding): string {
  const buf = fs.readFileSync(filePath);
  if (enc.isUtf8) {
    // Native path: identical to the old fs.readFileSync(p, "utf8").
    // For UTF-8 with BOM, slice off the BOM so it does not leak into content
    // matching (it would prefix the first line and break old_str lookups).
    const slice = enc.hasBOM ? buf.subarray(3) : buf;
    return slice.toString("utf8");
  }
  return iconv.decode(buf, enc.encoding, { stripBOM: true });
}

/** Write a string back to a file, encoding via the detected encoding. */
export function writeFileEncoded(
  filePath: string,
  content: string,
  enc: FileEncoding,
): void {
  if (enc.isUtf8) {
    if (enc.hasBOM) {
      const body = Buffer.from(content, "utf8");
      const out = Buffer.concat([UTF8_BOM, body]);
      fs.writeFileSync(filePath, out);
      return;
    }
    fs.writeFileSync(filePath, content, "utf8");
    return;
  }
  const buf = iconv.encode(content, enc.encoding, { addBOM: enc.hasBOM });
  fs.writeFileSync(filePath, buf);
}
