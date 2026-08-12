import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterResumeError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpUnsupportedCapabilityError = Schema.is(EffectAcpErrors.AcpUnsupportedCapabilityError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function mapAcpOrAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError | ProviderAdapterError,
): ProviderAdapterError {
  switch (error._tag) {
    case "ProviderAdapterValidationError":
    case "ProviderAdapterSessionNotFoundError":
    case "ProviderAdapterSessionClosedError":
    case "ProviderAdapterRequestError":
    case "ProviderAdapterProcessError":
    case "ProviderAdapterResumeError":
      return error;
    default:
      return mapAcpToAdapterError(provider, threadId, method, error);
  }
}

/**
 * Map a failure from `AcpSessionRuntime.start()`. A start that carried a
 * resume cursor and died on the resume itself becomes a
 * `ProviderAdapterResumeError`, so a caller can tell "this conversation is
 * gone" apart from "this agent is broken" and fall back deliberately.
 */
export function mapAcpSessionStartError(input: {
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly method: string;
  readonly resumeSessionId: string | undefined;
  readonly error: EffectAcpErrors.AcpError;
}): ProviderAdapterError {
  const { error, provider, resumeSessionId, threadId } = input;
  if (resumeSessionId !== undefined && isAcpUnsupportedCapabilityError(error)) {
    return new ProviderAdapterResumeError({
      provider,
      threadId,
      resumeSessionId,
      detail: error.detail ?? error.message,
      cause: error,
    });
  }
  return mapAcpToAdapterError(provider, threadId, input.method, error);
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
