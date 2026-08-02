import type { T3SessionEnvironment } from "@t3tools/contracts";

/**
 * Maps the server environment attached to a provider session start onto the
 * `T3_*` env vars injected into the agent's spawn environment. In-t3code
 * skills (for example `/cook-epic`) use these to detect the server and drive
 * its HTTP API.
 */
export function toT3EnvironmentEnv(t3Environment: T3SessionEnvironment): Record<string, string> {
  return {
    T3_SERVER_URL: t3Environment.serverUrl,
    T3_ENVIRONMENT_ID: t3Environment.environmentId,
    T3_PROJECT_ID: t3Environment.projectId,
    T3_WORKSPACE_ROOT: t3Environment.workspaceRoot,
    T3_SERVER_TOKEN: t3Environment.token,
  };
}
