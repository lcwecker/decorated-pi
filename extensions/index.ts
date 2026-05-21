/**
 * decorated-pi — Essential utilities for pi
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupSafety } from "./safety/index.js";
import { setupModelIntegration } from "./model-integration";
import { setupSlash } from "./slash";
import { setupSubdirAgents } from "./subdir-agents";
import { setupSessionTitle } from "./session-title";
import { setupIO } from "./io";
import { setupGuidance } from "./guidance";
import { setupLsp } from "./lsp/index";
import { setupProviders } from "./providers/index";
import { setupSmartAt } from "./smart-at";
import { setupMcp } from "./mcp/index.js";
import { isModuleEnabled } from "./settings";

export default function (pi: ExtensionAPI) {
  // Always loaded — core commands and providers
  setupSlash(pi);
  setupProviders(pi);
  setupModelIntegration(pi);
  setupSubdirAgents(pi);
  setupSessionTitle(pi);
  setupGuidance(pi);

  // Configurable modules
  if (isModuleEnabled("patch"))     setupIO(pi);
  if (isModuleEnabled("safety"))    setupSafety(pi);
  if (isModuleEnabled("lsp"))       setupLsp(pi);
  if (isModuleEnabled("smart-at"))  setupSmartAt(pi);
  if (isModuleEnabled("mcp"))       setupMcp(pi);
}
