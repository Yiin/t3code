import * as Context from "effect/Context";

/** Marker for the projection module. Table repositories stay private to its layers. */
export interface ProjectionStoreShape {}

export class ProjectionStore extends Context.Service<ProjectionStore, ProjectionStoreShape>()(
  "t3/persistence/Services/ProjectionStore",
) {}
