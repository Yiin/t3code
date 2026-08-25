import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "./config.ts";
import { sweepExpiredUploads } from "./attachmentStore.ts";

/** How long a staged upload may sit unclaimed before the sweep removes it. */
const UPLOAD_MAX_AGE = Duration.hours(1);

/** How often the sweep runs. */
const SWEEP_INTERVAL = Duration.minutes(10);

const makeAttachmentUploadSweeper = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;

  const sweep = Effect.sync(() =>
    sweepExpiredUploads({
      attachmentsDir: serverConfig.attachmentsDir,
      maxAgeMs: Duration.toMillis(UPLOAD_MAX_AGE),
    }),
  );

  yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));
});

// Removes `POST /api/attachments` staging files (attachmentStore.ts) that a
// turn never claimed, so an abandoned upload doesn't sit on disk forever.
export const AttachmentUploadSweeperLive = Layer.effectDiscard(makeAttachmentUploadSweeper);
