import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";
import { createAuthEnvironmentAtoms } from "@t3tools/client-runtime/state/auth";
import { createFilesystemEnvironmentAtoms } from "@t3tools/client-runtime/state/filesystem";
import { createGitEnvironmentAtoms } from "@t3tools/client-runtime/state/git";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";
import { Discovery } from "@t3tools/client-runtime/relay";
import { createRelayEnvironmentDiscoveryAtoms } from "@t3tools/client-runtime/state/relay";
import { createReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/review";
import { createSourceControlEnvironmentAtoms } from "@t3tools/client-runtime/state/source-control";
import { createTerminalEnvironmentAtoms } from "@t3tools/client-runtime/state/terminal";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations, useEnvironmentPresentation } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";
import { usePreparedConnection } from "./session";

export const gitEnvironment = createGitEnvironmentAtoms(connectionAtomRuntime);
export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);
export const authEnvironment = createAuthEnvironmentAtoms(connectionAtomRuntime);
export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);
export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime);
export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);
export const relayEnvironmentDiscovery: ReturnType<typeof createRelayEnvironmentDiscoveryAtoms> =
  createRelayEnvironmentDiscoveryAtoms(connectionAtomRuntime);
export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime);
export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(connectionAtomRuntime);
export const terminalEnvironment = createTerminalEnvironmentAtoms(connectionAtomRuntime);

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}

function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
): EnvironmentPresentation {
  return {
    ...presentation,
    environmentId,
    label: presentation.entry.target.label,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation),
      ),
    [presentationById],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation),
    [environmentId, presentation],
  );
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

export function useEnvironmentConnectionState(environmentId: EnvironmentId) {
  return useEnvironmentQuery(environmentCatalog.stateAtom(environmentId));
}
