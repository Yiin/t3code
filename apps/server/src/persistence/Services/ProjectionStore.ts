import * as Context from "effect/Context";

import {
  ProjectionPendingApprovalRepository,
  type ProjectionPendingApprovalRepositoryShape,
} from "./ProjectionPendingApprovals.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "./ProjectionProjects.ts";
import {
  ProjectionStateRepository,
  type ProjectionStateRepositoryShape,
} from "./ProjectionState.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivityRepositoryShape,
} from "./ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "./ProjectionThreadMessages.ts";
import {
  ProjectionThreadProposedPlanRepository,
  type ProjectionThreadProposedPlanRepositoryShape,
} from "./ProjectionThreadProposedPlans.ts";
import {
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
} from "./ProjectionThreadSessions.ts";
import {
  ProjectionThreadSubagentRepository,
  type ProjectionThreadSubagentRepositoryShape,
} from "./ProjectionThreadSubagents.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "./ProjectionThreads.ts";
import { ProjectionTurnRepository, type ProjectionTurnRepositoryShape } from "./ProjectionTurns.ts";

export interface ProjectionStoreShape {
  readonly projects: ProjectionProjectRepositoryShape;
  readonly threads: ProjectionThreadRepositoryShape;
  readonly threadMessages: ProjectionThreadMessageRepositoryShape;
  readonly threadProposedPlans: ProjectionThreadProposedPlanRepositoryShape;
  readonly threadActivities: ProjectionThreadActivityRepositoryShape;
  readonly threadSubagents: ProjectionThreadSubagentRepositoryShape;
  readonly threadSessions: ProjectionThreadSessionRepositoryShape;
  readonly turns: ProjectionTurnRepositoryShape;
  readonly pendingApprovals: ProjectionPendingApprovalRepositoryShape;
  readonly state: ProjectionStateRepositoryShape;
}

export class ProjectionStore extends Context.Service<ProjectionStore, ProjectionStoreShape>()(
  "t3/persistence/Services/ProjectionStore",
) {}

export {
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
};

export * from "./ProjectionPendingApprovals.ts";
export * from "./ProjectionProjects.ts";
export * from "./ProjectionState.ts";
export * from "./ProjectionThreadActivities.ts";
export * from "./ProjectionThreadMessages.ts";
export * from "./ProjectionThreadProposedPlans.ts";
export * from "./ProjectionThreadSessions.ts";
export * from "./ProjectionThreadSubagents.ts";
export * from "./ProjectionThreads.ts";
export * from "./ProjectionTurns.ts";
