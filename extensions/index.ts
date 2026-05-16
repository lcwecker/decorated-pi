/**
 * decorated-pi — Essential utilities for pi
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupSafety } from "./safety/index.js";
import { setupExtendModel } from "./extend-model";
import { setupSlash } from "./slash";
import { setupSubdirAgents } from "./subdir-agents";
import { setupSessionTitle } from "./session-title";
import { setupGuidance } from "./guidance";
import { setupLsp } from "./lsp/index";
import { setupProviders } from "./providers/index";
import { setupSmartAt } from "./smart-at";
import { isModuleEnabled } from "./settings";

export default function (pi: ExtensionAPI) {
  // Always loaded — core commands and providers
  setupSlash(pi);
  setupProviders(pi);
  setupExtendModel(pi);
  setupSubdirAgents(pi);
  setupSessionTitle(pi);
  setupGuidance(pi);

  // Configurable modules
  if (isModuleEnabled("safety"))    setupSafety(pi);
  if (isModuleEnabled("lsp"))       setupLsp(pi);
  if (isModuleEnabled("smart-at"))  setupSmartAt(pi);
}
