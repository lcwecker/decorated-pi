import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DECORATED_PI_GUIDANCE_MARKER = "## Decorated Pi Guidance";

export function setupGuidance(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (event.systemPrompt.includes(DECORATED_PI_GUIDANCE_MARKER)) return;

    const guidance = [
      DECORATED_PI_GUIDANCE_MARKER,
      "",
      "- Before acting on a user's prompt, ensure you fully understand their needs. If the intent is ambiguous, ask clarifying questions. Proceed only when the intent is clear.",
      "- Look before you leap! Ensure you have conducted thorough research before taking any action.",
      "- Exercise caution when performing any **write** operations, especially when you are in a research or exploration phase."
    ].join("\n");

    return {
      systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
    };
  });
}
