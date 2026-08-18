import * as Cause from "effect/Cause";

const MAX_ERROR_TRACE_NODES = 128;

export function findErrorTraceId(error: unknown): string | null {
  const seen = new Set<object>();
  const pending: Array<unknown> = [error];
  let inspectedNodeCount = 0;

  while (pending.length > 0 && inspectedNodeCount < MAX_ERROR_TRACE_NODES) {
    const current = pending.pop();
    inspectedNodeCount += 1;
    if (typeof current !== "object" || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const traceId = "traceId" in current ? current.traceId : undefined;
    if (typeof traceId === "string" && traceId.trim().length > 0) {
      return traceId;
    }

    const errors = "errors" in current ? current.errors : undefined;
    if (Array.isArray(errors)) {
      for (let index = errors.length - 1; index >= 0; index -= 1) {
        pending.push(errors[index]);
      }
    }
    if (Cause.isCause(current)) {
      for (let index = current.reasons.length - 1; index >= 0; index -= 1) {
        const reason = current.reasons[index];
        switch (reason?._tag) {
          case "Fail":
            pending.push(reason.error);
            break;
          case "Die":
            pending.push(reason.defect);
            break;
        }
      }
    }
    if ("cause" in current) {
      pending.push(current.cause);
    }
  }

  return null;
}
