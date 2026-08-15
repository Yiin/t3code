import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createSkillsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listForThread: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:skills:list-for-thread",
      tag: WS_METHODS.skillsListForThread,
      staleTimeMs: 5_000,
    }),
  };
}
