# Epic-run transcript mapping

The conformance transcript records stable decisions. It keeps timestamps, thread identifiers, process identifiers, run paths, and cost in metadata. Comparators remove that metadata.

The terminal adapter is the shared core reached through `skills/cook-epic/run.sh`, which execs `t3 epic cook`. Its `mailbox.jsonl` records are the `FileRunEvents` format: one JSON `RunEvent` per line (`run-state-changed`, `iteration-state-changed`, `child-claim-released`, `provider-fallback`, and the subagent-liveness records). The terminal adapter adds `pushed` and `verified` to every normalized event. The server adapter must synthesize those values from its launch policy and gate result.

## Shared core records

The contract also accepts the shared `run-state-changed` and `iteration-state-changed` records directly. An adapter expands them into the specific decision tags before comparison. This boundary avoids false differences caused by store writes that occur before policy decisions. The shared event stream also has `subagent-liveness-degraded` and `subagent-liveness-unavailable`. Terminal adapters synthesize these from harness capabilities. They are separate from worker-idle inspection events.

| Shared record                   | Meaning                                                     | Verdict                                                                         |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `iteration-state-changed`       | The core persisted an iteration state transition.           | Adapters expand it into dispatched, done, retry, blocked, or completed-no-code. |
| `run-state-changed`             | The core persisted a run state transition.                  | Adapters expand terminal statuses into the finished decision.                   |
| `subagent-liveness-degraded`    | Live subagent evidence is partial for the iteration.        | The terminal adapter reports it from harness capabilities.                      |
| `subagent-liveness-unavailable` | The harness exposes no subagent evidence for the iteration. | The terminal adapter reports it from harness capabilities.                      |

## Terminal events with a server transition

| Terminal event      | Server or shared-core transition                                                 | Normalization verdict                                                                          |
| ------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `blocked`           | A failed iteration reaches the child failure limit and the run becomes failed.   | The shared core emits the concept. Each adapter supplies the child and attempt count.          |
| `completed-no-code` | An iteration completes after the child closes with new bead evidence.            | The shared core emits the concept after evidence checks.                                       |
| `dispatched`        | `iteration-state-changed` creates a running iteration.                           | The server adapter synthesizes worker and branch metadata.                                     |
| `done`              | `iteration-state-changed` settles a completed iteration with code.               | The terminal adapter maps commit and repository details into metadata.                         |
| `finished`          | `run-state-changed` enters done, failed, or cancelled.                           | Each adapter maps its terminal reason to the shared run status.                                |
| `lock_held`         | Preflight fails because the shared epic lock is owned.                           | The adapters synthesize the same stable reason and keep owner data in metadata.                |
| `provider-fallback` | Boundary policy updates the persisted model selection and continues.             | The shared core emits the selected provider pair.                                              |
| `rate-limited`      | A provider-attributed infrastructure failure reopens the child and retries.      | The shared core emits retry classification. The terminal adapter keeps this more specific tag. |
| `retry`             | A failed iteration remains below its failure budget and continues after backoff. | The shared core emits the attempt and stable reason.                                           |

## Terminal events without a server counterpart

| Terminal event            | Current terminal meaning                                             | Verdict                                                            |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `folded`                  | A child decision or warning was folded into the epic body.           | The shared core grows this post-child action.                      |
| `inspection-continue`     | An inspector keeps an idle worker alive and schedules another check. | The shared supervisor grows this decision.                         |
| `inspection-started`      | A bounded idle-worker inspection started.                            | The shared supervisor grows this decision.                         |
| `inspection-stop`         | Two stable high-confidence inspections stopped a worker.             | The shared supervisor grows this decision.                         |
| `inspection-stop-pending` | One high-confidence stop awaits independent confirmation.            | The shared supervisor grows this decision.                         |
| `inspection-uncertain`    | An invalid, weak, or failed inspection kept the worker alive.        | The shared supervisor grows this decision.                         |
| `merged`                  | A verified trial merge landed one repository set.                    | The shared parallel coordinator grows this action.                 |
| `parked`                  | A branch set could not land and a merge-fix child was created.       | The shared parallel coordinator grows this action.                 |
| `researched`              | A research child closed with bead findings and no code.              | The shared core grows this evidence-specific completion.           |
| `worker-cap`              | The live parallel worker limit changed.                              | The terminal adapter synthesizes this operator-only control event. |
| `worker-idle`             | A worker crossed the idle threshold before inspection.               | The shared supervisor grows this observation.                      |

## Server iteration fields without a terminal field

| Server field     | Terminal source                                                   | Verdict                                                              |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `iterationIndex` | Mailbox sequence and dispatch order.                              | The terminal adapter synthesizes the stable zero-based index.        |
| `threadId`       | No stable terminal value.                                         | The adapter stores it in ignored transcript metadata when available. |
| `workerId`       | Worker lifecycle events.                                          | The terminal adapter copies the worker identity when available.      |
| `issueId`        | Mailbox `child`.                                                  | The terminal adapter renames it. Run-level records use null.         |
| `branch`         | Worker checkout events.                                           | The terminal adapter copies the per-child branch when available.     |
| `worktreePath`   | Worker checkout events.                                           | The terminal adapter copies the per-child path when available.       |
| `turnStatus`     | Dispatch, completion, retry, blocked, and interruption events.    | The adapter synthesizes the four-state value.                        |
| `summary`        | Worker result text or the terminal event reason.                  | The adapter includes only stable worker-reported text.               |
| `why`            | The structured worker report.                                     | The terminal adapter copies it when the harness supplies it.         |
| `failureReason`  | Retry, blocked, rate-limit, timeout, and provider classification. | The shared core owns the closed classified value.                    |
| `startedAt`      | Mailbox timestamp.                                                | The adapter moves it to ignored transcript metadata.                 |
| `finishedAt`     | Mailbox timestamp.                                                | The adapter moves it to ignored transcript metadata.                 |
