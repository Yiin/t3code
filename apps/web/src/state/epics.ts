import { createEpicsEnvironmentAtoms } from "@t3tools/client-runtime/state/epics";

import { connectionAtomRuntime } from "../connection/runtime";

export const epicsEnvironment = createEpicsEnvironmentAtoms(connectionAtomRuntime);
