const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session";
const DECLINE = "Decline";
const CANCEL = "Cancel";
const OPTIONS = [ALLOW_ONCE, ALLOW_SESSION, DECLINE, CANCEL];
const PROMPT_TIMEOUT_MS = 300_000;
const IPYTHON_TOOL_NAMES = new Set(["ipython", "python", "python_cell"]);

/**
 * T3 owns this extension. Prime loads it once for each provider session.
 * The closure therefore scopes an allow-for-session grant to one process.
 */
export default function t3PermissionExtension(pi) {
  let allowForSession = false;

  pi.on("tool_call", async (event, ctx) => {
    if (!IPYTHON_TOOL_NAMES.has(event?.toolName)) return undefined;
    if (process.env.T3_PRIME_RUNTIME_MODE === "full-access" || allowForSession) return undefined;

    try {
      if (!ctx?.ui || typeof ctx.ui.select !== "function") {
        return { block: true, reason: "T3 permission prompt is unavailable" };
      }
      const input = event.input && typeof event.input === "object" ? event.input : {};
      const choice = await ctx.ui.select(
        `Allow this complete ${event.toolName} call?\n\n${JSON.stringify(input, null, 2)}`,
        OPTIONS,
        { timeout: PROMPT_TIMEOUT_MS },
      );
      if (choice === ALLOW_ONCE) return undefined;
      if (choice === ALLOW_SESSION) {
        allowForSession = true;
        return undefined;
      }
      return {
        block: true,
        reason: choice === CANCEL ? "Cancelled by user" : "Declined by user",
      };
    } catch {
      return { block: true, reason: "T3 permission check failed" };
    }
  });
}
