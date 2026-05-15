/**
 * decorated-pi — Essential utilities for pi
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupSafety } from "./safety";
import { setupExtendModel } from "./extend-model";
import { setupSlash } from "./slash";
import { setupSubdirAgents } from "./subdir-agents";
import { setupSessionTitle } from "./session-title";
import { setupGuidance } from "./guidance";
import { setupLsp } from "./lsp/index";
import { setupSmartAt } from "./smart-at";

export default function (pi: ExtensionAPI) {
  setupSafety(pi);
  setupExtendModel(pi);
  setupSlash(pi);
  setupSubdirAgents(pi);
  setupSessionTitle(pi);
  setupGuidance(pi);
  setupLsp(pi);
  setupSmartAt(pi);
}
