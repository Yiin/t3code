/**
 * The locked-down inspector's prompt, rendered from structural evidence only.
 *
 * The inspector is the one place where a language model may end a worker, so
 * what reaches it is a whitelist, not a redaction pass: counts, seconds, byte
 * deltas, digests and allowlisted process names. Worker text, command
 * arguments, environment values, URLs, headers and file contents never appear,
 * because none of them has a shape this module can emit.
 *
 * Rendering is pure and total. Every caller-supplied string passes
 * {@link sanitizeToken} or is dropped by {@link structuralLines}, so an adapter
 * cannot widen the channel by handing over a richer summary line.
 *
 * Ported from `skills/cook-epic/inspector-prompt.md` and `render_inspector_prompt`
 * (run-legacy.sh:1320-1354); run-legacy.sh retired in t3code-06s.42 and its line
 * references resolve in git history.
 */

/** The fixed instruction half, verbatim from the retired `inspector-prompt.md`. */
export const INSPECTOR_PROMPT_TEMPLATE = `You are a liveness inspector for one cook-epic worker. Decide whether the worker is doing legitimate long-running work or is idle or stuck.

You receive one fixed structural evidence snapshot. It contains counts, times, tool names, resource deltas, and repository status counts. It does not contain worker text, command arguments, environment values, URLs, headers, cookies, or file contents. Do not use tools. Do not read or write files. Do not run commands, tests, builds, renderers, or other agents. Do not change beads. Do not signal any process.

Process existence alone is not progress. Sustained CPU or I/O can prove that a silent renderer, compiler, test, or similar command is active. New output bytes or repository movement can also prove progress. Use \`uncertain\` when the structural evidence does not support a confident result.

Return exactly one JSON object and no other text:

{"decision":"continue|stop|uncertain","confidence":"high|medium|low","rationale":"one concise factual sentence","next_check_seconds":1800}

Use \`continue\` for legitimate work. Use \`stop\` only when the evidence clearly shows an idle loop, dead wait, repeated failure, or other stuck state. Use \`uncertain\` for weak, conflicting, incomplete, or stale evidence. Include \`next_check_seconds\` only for \`continue\` or \`uncertain\` when a specific delay helps.`;

/** What one `key=value` structural line may contain. */
const STRUCTURAL_LINE = /^[a-z][a-z0-9-]*=[A-Za-z0-9._:-]+(?: [a-z][a-z0-9-]*=[A-Za-z0-9._:-]+)*$/;

/**
 * Longest identifier the prompt will carry. Sized for the repository
 * fingerprint, which is a 40-character HEAD plus a sha256 digest.
 */
const MAX_TOKEN_LENGTH = 128;

/**
 * One identifier, reduced to the characters an identifier needs.
 *
 * A terminal worker key is an artifact path and a child is a Beads id, so the
 * separators that would carry a directory tree are the first thing to go.
 */
export const sanitizeToken = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "unavailable" : cleaned.slice(0, MAX_TOKEN_LENGTH);
};

/** Drop every summary line that is not plain `key=value` pairs. */
export const structuralLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.map((line) => line.trim()).filter((line) => STRUCTURAL_LINE.test(line));

/**
 * The machine's own view of one worker at the instant it asked for an
 * inspection. Every field is a number or a digest the machine already holds,
 * so gathering it costs no extra probe.
 */
export interface InspectorLaunchEvidence {
  readonly worker: string;
  readonly child: string;
  readonly elapsedSeconds: number;
  readonly idleSeconds: number;
  readonly outputBytes: number;
  readonly outputBytesDelta: number;
  readonly cpuUsecDelta: number;
  readonly ioBytesDelta: number;
  /** sha256 of the comm histogram, or `unavailable` (`workerLiveness.ts`). */
  readonly processFingerprint: string;
  /** `<head> hash=<digest>`, or the probe-timeout marker (`workerLiveness.ts`). */
  readonly repoFingerprint: string;
}

/**
 * Host-side detail the machine never sees: which allowlisted commands are
 * running, and how many paths the repository has in each status class. Both
 * are `key=value` lines and both may be empty when the host cannot tell.
 */
export interface WorkerStructureSummary {
  readonly processes: ReadonlyArray<string>;
  readonly repository: ReadonlyArray<string>;
}

export const EMPTY_WORKER_STRUCTURE: WorkerStructureSummary = { processes: [], repository: [] };

const section = (title: string, lines: ReadonlyArray<string>): string =>
  `### ${title}\n\n${lines.length === 0 ? "unavailable" : lines.join("\n")}`;

const count = (value: number): string =>
  Number.isFinite(value) ? String(Math.trunc(value)) : "unavailable";

export interface InspectorPromptInput {
  readonly evidence: InspectorLaunchEvidence;
  readonly structure: WorkerStructureSummary;
  /** Hard cap on the rendered prompt; the machine's `repoEvidenceBytes + 8192`. */
  readonly maxBytes: number;
}

/**
 * The whole prompt: the fixed instructions, then one bounded evidence block.
 *
 * Truncation is by bytes from the end, so an oversized structural section can
 * never push the instructions out of the prompt.
 */
export const renderInspectorPrompt = (input: InspectorPromptInput): string => {
  const evidence = input.evidence;
  const body = [
    INSPECTOR_PROMPT_TEMPLATE,
    "",
    "## Bounded allowlisted activity summary",
    "",
    `worker=${sanitizeToken(evidence.worker)}`,
    `child=${sanitizeToken(evidence.child)}`,
    `elapsed-seconds=${count(evidence.elapsedSeconds)}`,
    `idle-seconds=${count(evidence.idleSeconds)}`,
    `output-bytes=${count(evidence.outputBytes)}`,
    `output-bytes-delta=${count(evidence.outputBytesDelta)}`,
    `cpu-usec-delta=${count(evidence.cpuUsecDelta)}`,
    `io-bytes-delta=${count(evidence.ioBytesDelta)}`,
    `process-fingerprint=${sanitizeToken(evidence.processFingerprint)}`,
    `repository-fingerprint=${sanitizeToken(evidence.repoFingerprint)}`,
    "worker-exit-state=running",
    "",
    section("Process tree and resources", structuralLines(input.structure.processes)),
    "",
    section("Bounded repository activity", structuralLines(input.structure.repository)),
    "",
  ].join("\n");
  return Buffer.byteLength(body) <= input.maxBytes
    ? body
    : Buffer.from(body).subarray(0, input.maxBytes).toString();
};
