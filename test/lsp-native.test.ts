import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspServerManager } from "../tools/lsp/manager.js";

let root = "";
let manager: LspServerManager | null = null;

afterEach(async () => {
  await manager?.clearLanguageState();
  manager = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("bundled native LSP servers", () => {
  it("reports real TypeScript diagnostics through the LSP manager", async () => {
    root = mkdtempSync(join(tmpdir(), "decorated-pi-ts7-lsp-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", noEmit: true },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src", "app.ts"), "const value: string = 42;\n");

    manager = new LspServerManager({ cwd: () => root });
    const resolved = await manager.resolveFileState("src/app.ts", { timeoutMs: 15_000 });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.result.state.command).toBe(process.execPath);

    const diagnostics = await resolved.result.state.client.waitForDiagnostics(
      resolved.result.uri,
      5_000,
    );
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 1,
        code: 2322,
        message: expect.stringContaining("not assignable to type 'string'"),
      }),
    ]));
  }, 25_000);

  it("reports real JSON diagnostics through the bundled Biome LSP", async () => {
    root = mkdtempSync(join(tmpdir(), "decorated-pi-biome-lsp-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(join(root, "broken.json"), "{\"enabled\": }\n");

    manager = new LspServerManager({ cwd: () => root });
    const resolved = await manager.resolveFileState("broken.json", { timeoutMs: 15_000 });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.result.state.command).toBe(process.execPath);

    const diagnostics = await resolved.result.state.client.waitForDiagnostics(
      resolved.result.uri,
      5_000,
    );
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 1,
        message: expect.any(String),
      }),
    ]));
  }, 25_000);
});
