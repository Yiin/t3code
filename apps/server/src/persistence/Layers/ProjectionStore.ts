import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import {
  ProjectionPendingApprovalRepository,
  ProjectionProjectRepository,
  ProjectionStateRepository,
  ProjectionThreadActivityRepository,
  ProjectionThreadMessageRepository,
  ProjectionThreadProposedPlanRepository,
  ProjectionThreadSessionRepository,
  ProjectionThreadSubagentRepository,
  ProjectionThreadRepository,
  ProjectionTurnRepository,
  ProjectionStore,
} from "../Services/ProjectionStore.ts";

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

const projectionStore = Layer.effect(
  ProjectionStore,
  Effect.gen(function* () {
    return {
      projects: yield* ProjectionProjectRepository,
      threads: yield* ProjectionThreadRepository,
      threadMessages: yield* ProjectionThreadMessageRepository,
      threadProposedPlans: yield* ProjectionThreadProposedPlanRepository,
      threadActivities: yield* ProjectionThreadActivityRepository,
      threadSubagents: yield* ProjectionThreadSubagentRepository,
      threadSessions: yield* ProjectionThreadSessionRepository,
      turns: yield* ProjectionTurnRepository,
      pendingApprovals: yield* ProjectionPendingApprovalRepository,
      state: yield* ProjectionStateRepository,
    };
  }),
).pipe(Layer.provide(repositoryLayers));

/** Provides the unified store and its compatibility repository facets. */
export const ProjectionStoreLive = Layer.merge(repositoryLayers, projectionStore);
