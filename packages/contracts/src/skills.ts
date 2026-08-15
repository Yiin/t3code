import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const SkillsListForThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * The thread's project, sent because a composer draft holds a pre-allocated
   * thread id that the server has not persisted yet. Without it the server
   * cannot resolve a draft's workspace root, so the draft would list only
   * global skills — and the client would keep that answer after the draft
   * becomes a real thread under the same id.
   */
  projectId: Schema.optionalKey(ProjectId),
});
export type SkillsListForThreadInput = typeof SkillsListForThreadInput.Type;
