import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { mergeEnvironmentThread } from "@t3tools/client-runtime/state/threads";
import type {
  OrchestrationProposedPlan,
  OrchestrationThreadActivityTruncation,
  OrchestrationThreadSubagent,
  ScopedThreadRef,
  ServerConfig,
} from "@t3tools/contracts";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

export const activeEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-active-environment-id"),
);

export function useActiveEnvironmentId(): EnvironmentId | null {
  return useAtomValue(activeEnvironmentIdAtom);
}

export function setActiveEnvironmentId(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(activeEnvironmentIdAtom, environmentId);
}

export function useThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  return useAtomValue(environmentThreadShells.threadRefsAtom);
}

export function useEnvironmentThreadRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedThreadRef> {
  return useAtomValue(environmentThreadShells.environmentThreadRefsAtom(environmentId));
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsAtom);
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  return useAtomValue(allEnvironmentShellsBootstrappedAtom);
}

export function useThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsForProjectRefsAtom(refs));
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(environmentThreadShells.threadShellAtom(ref));
}

export function useThreadDetail(ref: ScopedThreadRef | null): EnvironmentThread | null {
  return useAtomValue(environmentThreadDetails.detailAtom(ref));
}

/** Detail collections composed with shell-authoritative thread/workspace metadata. */
export function useThread(ref: ScopedThreadRef | null): EnvironmentThread | null {
  const shell = useThreadShell(ref);
  const detail = useThreadDetail(ref);
  return useMemo(() => mergeEnvironmentThread(detail, shell), [detail, shell]);
}

/** Present when the server returned only part of the thread's activity history. */
export function useThreadActivitiesTruncated(
  ref: ScopedThreadRef | null,
): OrchestrationThreadActivityTruncation | null {
  return useAtomValue(environmentThreadDetails.activitiesTruncatedAtom(ref));
}

/** Ad-hoc subagents (Agent/Task spawns) folded from the thread's activities. */
export function useThreadSubagents(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationThreadSubagent> {
  return useAtomValue(environmentThreadDetails.subagentsAtom(ref));
}

export function useThreadProposedPlans(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationProposedPlan> {
  return useAtomValue(environmentThreadDetails.proposedPlansAtom(ref));
}

export function readProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return appAtomRegistry.get(environmentProjects.projectAtom(ref));
}

export function readThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
}

/** Whether the environment's server understands thread.settle/unsettle.
    False for pre-settlement servers (capability defaults false on decode),
    so clients under version skew fall back instead of erroring. */
export function readEnvironmentSupportsSettlement(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry.get(environmentThreadShells.environmentThreadRefsAtom(environmentId));
}
