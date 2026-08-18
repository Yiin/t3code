/**
 * activityPayload - read a projected activity payload in a test.
 *
 * `OrchestrationThreadActivity.payload` is `Schema.Unknown` in the contract, so
 * the read model hands a test a value with no field contract. Tests used to
 * cast each read to `Record<string, unknown>`, which asserts a shape the
 * projector may never have written.
 *
 * This is the one narrowing gate. A payload that is not an object reads as
 * `undefined` instead of throwing, so an assertion on a missing field fails on
 * its own value rather than on a `TypeError`.
 *
 * @module activityPayload
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/** The fields of one projected activity payload. */
export type ActivityPayloadFields = Record<string, unknown>;

function isActivityPayloadFields(
  payload: OrchestrationThreadActivity["payload"],
): payload is ActivityPayloadFields {
  return typeof payload === "object" && payload !== null;
}

/** Read one activity payload as fields, or `undefined` when it carries none. */
export function activityPayloadFields(
  payload: OrchestrationThreadActivity["payload"],
): ActivityPayloadFields | undefined {
  return isActivityPayloadFields(payload) ? payload : undefined;
}
