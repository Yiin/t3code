/**
 * Live process facts for terminal workers, keyed by the iteration handle's ref.
 *
 * The terminal harness spawns and owns each worker process, so it is the only
 * honest source for two things the liveness machine reads and that no cgroup
 * file can answer: the never-truncated output byte counter
 * (`workerLiveness.ts:96-99`) and whether the worker's own child is still
 * running. `TerminalAgentDispatch` writes both here as it streams; the
 * `TerminalWorkerEvidence` adapter reads them back.
 *
 * The ref is the artifact path, exactly what `IterationHandle.ref` carries into
 * `WorkerRef.worker`, so no extra identity has to be threaded through the loop.
 *
 * Deliberately a plain mutable map, not an Effect service: it is written from
 * inside Node stream callbacks, where an Effect would have to be run anyway,
 * and its whole lifetime is one run's process.
 */
export interface TerminalWorkerSample {
  /** The worker's process group leader, or `null` before the spawn reported one. */
  readonly pid: number | null;
  /** False once the worker's child closed. A wedged worker stays true. */
  readonly live: boolean;
  /**
   * Cumulative stdout plus stderr bytes since the iteration started.
   *
   * Never truncated, unlike the artifact tail the dispatch compacts: the
   * machine reads deltas, so a counter that resets reads as no progress.
   * A continuation keeps counting into the same total.
   */
  readonly outputBytes: number;
}

export interface TerminalWorkerActivity {
  /** Reader half, for the evidence adapter. `null` when the ref is unknown. */
  readonly sample: (ref: string) => TerminalWorkerSample | null;
  /** A spawn, including the re-spawn a continuation makes, for the same ref. */
  readonly started: (ref: string, pid: number | null) => void;
  readonly appended: (ref: string, bytes: number) => void;
  /** The worker's child closed. The byte total stays readable. */
  readonly ended: (ref: string) => void;
}

export const makeTerminalWorkerActivity = (): TerminalWorkerActivity => {
  const entries = new Map<string, TerminalWorkerSample>();

  const update = (ref: string, change: Partial<TerminalWorkerSample>): void => {
    const current = entries.get(ref) ?? { pid: null, live: false, outputBytes: 0 };
    entries.set(ref, { ...current, ...change });
  };

  return {
    sample: (ref) => entries.get(ref) ?? null,
    started: (ref, pid) => {
      update(ref, { pid, live: true });
    },
    appended: (ref, bytes) => {
      update(ref, { outputBytes: (entries.get(ref)?.outputBytes ?? 0) + bytes });
    },
    ended: (ref) => {
      update(ref, { live: false });
    },
  };
};
