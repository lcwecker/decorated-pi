import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DECORATED_PI_GUIDANCE_MARKER = "## Decorated Pi Guidance";

export function setupGuidance(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (event.systemPrompt.includes(DECORATED_PI_GUIDANCE_MARKER)) return;

    const guidance = [
      DECORATED_PI_GUIDANCE_MARKER,
      "",
      "Before taking any action on a user's prompt, briefly restate your understanding of what the user wants. If ambiguous, ask clarifying questions. Only proceed after intent is clear.",
      "",
      "For medium-to-large tasks (more than 3 steps or touching multiple files/systems), break the task into discrete steps. For small tasks (1-2 steps), do it directly.",
    ].join("\n");

    return {
      systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
    };
  });
}
