import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUpdatedPayload } from "./server.ts";

export const ProviderAuthRunStatus = Schema.Literals([
  "idle",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ProviderAuthRunStatus = typeof ProviderAuthRunStatus.Type;

export const ProviderAuthRunState = Schema.Struct({
  status: ProviderAuthRunStatus,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  output: Schema.String.check(Schema.isMaxLength(10_000)),
  verificationUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  userCode: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
});
export type ProviderAuthRunState = typeof ProviderAuthRunState.Type;

export class ProviderAuthError extends Schema.TaggedErrorClass<ProviderAuthError>()(
  "ProviderAuthError",
  { message: Schema.String },
) {}

const OptionalAuthChoice = Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128)));

export const ProviderAuthLoginStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: OptionalAuthChoice,
  method: OptionalAuthChoice,
});
export type ProviderAuthLoginStartInput = typeof ProviderAuthLoginStartInput.Type;

export const ProviderAuthLoginStartResult = Schema.Struct({
  terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  state: ProviderAuthRunState,
});
export type ProviderAuthLoginStartResult = typeof ProviderAuthLoginStartResult.Type;

export const ProviderAuthLoginCancelInput = Schema.Struct({
  terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ProviderAuthLoginCancelInput = typeof ProviderAuthLoginCancelInput.Type;

export const ProviderAuthLoginCancelResult = Schema.Struct({ state: ProviderAuthRunState });
export type ProviderAuthLoginCancelResult = typeof ProviderAuthLoginCancelResult.Type;

export const ProviderAuthLoginStatusInput = ProviderAuthLoginCancelInput;
export type ProviderAuthLoginStatusInput = typeof ProviderAuthLoginStatusInput.Type;

export const ProviderAuthLogoutInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: OptionalAuthChoice,
  deleteAccountHome: Schema.optional(Schema.Boolean),
});
export type ProviderAuthLogoutInput = typeof ProviderAuthLogoutInput.Type;

export const ProviderAuthLogoutResult = ServerProviderUpdatedPayload;
export type ProviderAuthLogoutResult = typeof ProviderAuthLogoutResult.Type;
