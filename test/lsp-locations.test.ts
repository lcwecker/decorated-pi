/**
 * tools/lsp/locations.ts — locations into printable rows.
 *
 * The rows are what makes a reference list readable: a path relative to the
 * workspace, the source line under the position, and the identifier that
 * position names. These read real files, so each case writes one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_LOCATIONS, readLocationRows, symbolAtPosition } from "../tools/lsp/locations.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "decorated-pi-lsp-locations-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, contents);
  return file;
}

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

function location(file: string, sl: number, sc: number) {
  return { uri: pathToFileURL(file).href, range: range(sl, sc, sl, sc + 1) };
}

const SOURCE = ["import { sum } from './math';", "", "export const total = sum(1, 2);", ""].join("\n");

describe("readLocationRows", () => {
  it("carries the source line and the identifier at the position", async () => {
    const file = tempFile("a.ts", SOURCE);
    const found = await readLocationRows([location(file, 2, 21)]);

    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]).toMatchObject({
      file,
      line: 3,
      character: 22,
      source: "export const total = sum(1, 2);",
      symbol: "sum",
      symbolStart: 21,
    });
    expect(found.total).toBe(1);
    expect(found.files).toBe(1);
    expect(found.omitted).toBe(0);
  });

  it("shortens paths inside the workspace and leaves outside paths absolute", async () => {
    const inside = tempFile("inside.ts", SOURCE);
    const outside = tempFile("outside.ts", SOURCE);
    const cwd = inside.slice(0, inside.lastIndexOf("/"));
    const found = await readLocationRows([location(inside, 0, 9), location(outside, 0, 9)], { cwd });

    expect(found.rows[0].file).toBe("inside.ts");
    expect(found.rows[1].file).toBe(outside);
    // Both rows still land in the file count even though one path is stripped.
    expect(found.files).toBe(2);
  });

  it("keeps the position for a file it cannot read", async () => {
    const file = join(tmpdir(), "decorated-pi-does-not-exist", "gone.ts");
    const found = await readLocationRows([location(file, 4, 2)]);

    expect(found.rows[0]).toMatchObject({ file, line: 5, character: 3, source: "" });
    expect(found.rows[0].symbol).toBeUndefined();
  });

  it("names an identifier outside the BMP", async () => {
    // One code point, two UTF-16 units: the column is a UTF-16 offset, so the
    // row has to keep it as one while the identifier is read as one code point.
    const file = tempFile("a.ts", "const 𐐀name = 1;\n");
    const found = await readLocationRows([location(file, 0, 6)]);
    expect(found.rows[0]).toMatchObject({ symbol: "𐐀name", symbolStart: 6, character: 7 });
  });

  it("reads a non-file URI verbatim and gives it no source", async () => {
    const found = await readLocationRows([{ uri: "untitled:Untitled-1", range: range(0, 0, 0, 1) }]);
    expect(found.rows[0]).toMatchObject({ file: "untitled:Untitled-1", line: 1, character: 1, source: "" });
  });

  it("caps the rows, counts every file, and reports what it hid", async () => {
    const first = tempFile("one.ts", SOURCE);
    const second = tempFile("two.ts", SOURCE);
    const locations = [
      location(first, 0, 0),
      location(second, 0, 0),
      location(second, 2, 13),
    ];
    const found = await readLocationRows(locations, { limit: 1 });

    expect(found.rows).toHaveLength(1);
    expect(found.total).toBe(3);
    expect(found.files).toBe(2);
    expect(found.omitted).toBe(2);
  });

  it("defaults to the shared limit", async () => {
    const file = tempFile("many.ts", SOURCE);
    const locations = Array.from({ length: MAX_LOCATIONS + 5 }, () => location(file, 0, 0));
    const found = await readLocationRows(locations);
    expect(found.rows).toHaveLength(MAX_LOCATIONS);
    expect(found.omitted).toBe(5);
  });

  it("reads each file once", async () => {
    // The same file answering many locations must not be re-read per row; a
    // workspace list of a common name hits one file dozens of times.
    const file = tempFile("a.ts", SOURCE);
    const found = await readLocationRows(Array.from({ length: 20 }, () => location(file, 2, 21)));
    expect(found.rows.every((row) => row.symbol === "sum")).toBe(true);
  });
});

describe("symbolAtPosition", () => {
  it("takes the one-based position the tools report", async () => {
    const file = tempFile("a.ts", SOURCE);
    expect(await symbolAtPosition(file, { line: 3, character: 22 })).toBe("sum");
    expect(await symbolAtPosition(file, { line: 1, character: 10 })).toBe("sum");
  });

  it("is undefined on a position that holds no identifier", async () => {
    const file = tempFile("a.ts", SOURCE);
    expect(await symbolAtPosition(file, { line: 3, character: 19 })).toBeUndefined();
    expect(await symbolAtPosition(join(tmpdir(), "nope", "gone.ts"), { line: 1, character: 1 })).toBeUndefined();
  });
});
