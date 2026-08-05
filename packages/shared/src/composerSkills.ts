import type { ServerProviderSkill, ServerWorkspaceSlashCommand } from "@t3tools/contracts";

/**
 * Build the `$` skill menu list: provider-native skills first, then
 * workspace skills (SKILL.md files under the server's skills root) that
 * the provider does not already report under the same name.
 */
export function mergeComposerSkills(input: {
  readonly providerSkills: ReadonlyArray<ServerProviderSkill>;
  readonly workspaceCommands: ReadonlyArray<ServerWorkspaceSlashCommand>;
}): ServerProviderSkill[] {
  const seenNames = new Set(input.providerSkills.map((skill) => skill.name.toLowerCase()));
  const workspaceSkills: ServerProviderSkill[] = [];
  for (const command of input.workspaceCommands) {
    const key = command.name.toLowerCase();
    if (seenNames.has(key)) {
      continue;
    }
    seenNames.add(key);
    workspaceSkills.push({
      name: command.name,
      enabled: true,
      ...(command.description ? { description: command.description } : {}),
    });
  }
  return [...input.providerSkills, ...workspaceSkills];
}
