import * as Layer from "effect/Layer";

import { ProjectionPendingApprovalRepositoryLive } from "./ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "./ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "./ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "./ProjectionThreadSessions.ts";
import { ProjectionThreadSubagentRepositoryLive } from "./ProjectionThreadSubagents.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";

/** One persistence module for all projection repository implementations. */
const repositoryLayers = Layer.mergeAll(
  ProjectionProjectRepositoryLive,
  ProjectionThreadRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ProjectionThreadProposedPlanRepositoryLive,
  ProjectionThreadActivityRepositoryLive,
  ProjectionThreadSubagentRepositoryLive,
  ProjectionThreadSessionRepositoryLive,
  ProjectionTurnRepositoryLive,
  ProjectionPendingApprovalRepositoryLive,
  ProjectionStateRepositoryLive,
);

/** Provides the projection implementations with their private table seams. */
export const ProjectionStoreLive = repositoryLayers;
