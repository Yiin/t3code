// The shims must run on plain Node: CI runners do not provide bun, and an
// unexecutable shim makes every `bd show` fail, which the core reports as
// "epic not found" (t3code-66n). Keep them dependency-free CommonJS.
const nodeSleep = `const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`;

export const gitShim = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, rmdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
${nodeSleep}
const journal = process.env.CONFORMANCE_JOURNAL;
const git = process.env.CONFORMANCE_REAL_GIT;
const lock = process.env.CONFORMANCE_LOCK;
if (!journal || !git || !lock) throw new Error("missing conformance environment");
for (let attempt = 0; ; attempt += 1) {
  try { mkdirSync(lock); break; }
  catch (error) {
    if (error?.code !== "EEXIST" || attempt >= 2000) throw error;
    sleep(5);
  }
}
try { appendFileSync(journal, JSON.stringify({ tool: "git", argv: process.argv.slice(2) }) + "\\n"); }
finally { rmdirSync(lock); }
const result = spawnSync(git, process.argv.slice(2), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`;

export const bdShim = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } = require("node:fs");
${nodeSleep}
const statePath = process.env.CONFORMANCE_STATE;
const journal = process.env.CONFORMANCE_JOURNAL;
const lock = process.env.CONFORMANCE_LOCK;
if (!statePath || !journal || !lock) throw new Error("missing conformance environment");
for (let attempt = 0; ; attempt += 1) {
  try { mkdirSync(lock); break; }
  catch (error) {
    if (error?.code !== "EEXIST" || attempt >= 2000) throw error;
    sleep(5);
  }
}
process.on("exit", () => { try { rmdirSync(lock); } catch {} });
const argv = process.argv.slice(2);
appendFileSync(journal, JSON.stringify({ tool: "bd", argv }) + "\\n");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const fail = (message) => { console.error(message); process.exit(2); };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
const takeOption = (args, name) => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) fail("missing value for " + name);
  args.splice(index, 2);
  return value;
};
const removeFlags = (args, allowed) => {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (allowed.includes(args[index])) args.splice(index, 1);
  }
};
const issue = (id) => {
  if (id === state.epic.id && state.epic.exists) return state.epic;
  return state.children.find((child) => child.id === id) ?? null;
};
const render = (value) => console.log(JSON.stringify(value));
const command = argv.shift();
switch (command) {
  case "show": {
    const id = argv.shift(); removeFlags(argv, ["--json", "--long"]);
    if (!id || argv.length) fail("unsupported bd show arguments");
    const found = issue(id); if (!found) process.exit(1); render([found]); break;
  }
  case "ready": {
    const parent = takeOption(argv, "--parent");
    const limit = Number(takeOption(argv, "--limit") ?? state.children.length);
    removeFlags(argv, ["--json"]); if (argv.length) fail("unsupported bd ready arguments");
    render(state.children.filter((child) => child.status === "open" && (!parent || state.readyIncludesForeign || child.parent === parent)).slice(0, limit)); break;
  }
  case "list": {
    const parent = takeOption(argv, "--parent"); const status = takeOption(argv, "--status");
    removeFlags(argv, ["--json", "--all", "--flat"]); if (argv.length) fail("unsupported bd list arguments");
    render(state.children.filter((child) => (!parent || child.parent === parent) && (!status || child.status === status))); break;
  }
  case "update": {
    const id = argv.shift(); const found = issue(id); if (!found) fail("unknown issue");
    const claim = argv.includes("--claim");
    if (claim) argv.splice(argv.indexOf("--claim"), 1);
    const actor = takeOption(argv, "--actor"); const assignee = takeOption(argv, "--assignee");
    const status = takeOption(argv, "--status");
    const operations = Number(claim) + Number(status !== null) + Number(assignee !== null);
    if (operations < 1 || (claim && operations !== 1) || (actor !== null && !claim)) fail("bd update requires compatible operations");
    if (claim) { found.status = "in_progress"; if (actor) found.assignee = actor; }
    else if (status !== null || assignee !== null) {
      if (status !== null) found.status = status;
      if (assignee !== null) found.assignee = assignee;
    }
    else fail("unsupported bd update operation");
    if (argv.length) fail("unsupported bd update arguments"); save(); break;
  }
  case "close": {
    const id = argv.shift(); const found = issue(id); if (!found) fail("unknown issue");
    takeOption(argv, "--reason"); if (argv.length) fail("unsupported bd close arguments");
    found.status = "closed"; save(); break;
  }
  case "note": {
    const id = argv.shift(); const body = argv.shift(); const found = issue(id);
    if (!found || body === undefined || argv.length) fail("unsupported bd note arguments");
    found.notes = (found.notes ? found.notes + "\\n" : "") + body; save(); break;
  }
  case "comment": {
    const id = argv.shift(); const body = argv.shift(); const found = issue(id);
    if (!found || body === undefined || argv.length) fail("unsupported bd comment arguments");
    found.comments.push(body); found.comment_count = found.comments.length; save(); break;
  }
  case "dep": {
    if (argv.shift() !== "add" || argv.length !== 2) fail("unsupported bd dep arguments");
    const found = issue(argv[0]); if (!found || !issue(argv[1])) fail("unknown dependency issue");
    found.dependencies.push(argv[1]); save(); break;
  }
  case "create": {
    const title = argv.shift(); const parent = takeOption(argv, "--parent") ?? state.epic.id;
    const type = takeOption(argv, "--type"); const priority = takeOption(argv, "-p"); const description = takeOption(argv, "-d"); const dependency = takeOption(argv, "--deps");
    removeFlags(argv, ["--json"]); if (!title || !type || !priority || description === null || argv.length) fail("unsupported bd create arguments");
    const child = { id: "created-" + String(state.nextId++), title, status: "open", priority: Number(priority), issue_type: type, parent, description, dependencies: dependency === null ? [] : [dependency], labels: [], comment_count: 0, comments: [], notes: "" };
    state.children.push(child); save(); render(child); break;
  }
  case "label": {
    const action = argv.shift();
    const found = issue(argv[0]); if (!found) fail("unknown issue");
    if (action === "list" && argv.length === 1) { for (const label of found.labels) console.log("- " + label); break; }
    if (action === "add" && argv.length === 2) { if (!found.labels.includes(argv[1])) found.labels.push(argv[1]); save(); break; }
    if (action === "remove" && argv.length === 2) { found.labels = found.labels.filter((label) => label !== argv[1]); save(); break; }
    fail("unsupported bd label arguments"); break;
  }
  case "swarm": {
    if (!['create', 'validate', 'status'].includes(argv[0]) || argv.length !== 2) fail("unsupported bd swarm arguments");
    if (argv[0] === 'validate') console.log('valid'); break;
  }
  case "merge-slot": {
    const action = argv.shift(); takeOption(argv, "--holder"); removeFlags(argv, ["--json"]);
    if (!['create', 'acquire', 'release'].includes(action) || argv.length) fail("unsupported bd merge-slot arguments");
    if (action === 'acquire') render({ acquired: true, holder: null }); break;
  }
  default: fail("unsupported bd command: " + String(command));
}
`;

export const agentShim = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } = require("node:fs");
const { basename, dirname, join, resolve, sep } = require("node:path");
const { spawnSync } = require("node:child_process");
${nodeSleep}
const statePath = process.env.CONFORMANCE_STATE;
const journal = process.env.CONFORMANCE_JOURNAL;
const lock = process.env.CONFORMANCE_LOCK;
if (!statePath || !journal || !lock) throw new Error("missing conformance environment");
for (let attempt = 0; ; attempt += 1) {
  try { mkdirSync(lock); break; }
  catch (error) {
    if (error?.code !== "EEXIST" || attempt >= 2000) throw error;
    sleep(5);
  }
}
let ownsLock = true;
process.on("exit", () => { if (ownsLock) try { rmdirSync(lock); } catch {} });
const state = JSON.parse(readFileSync(statePath, "utf8"));
// A pool worker learns which child it owns from its own prompt, so two
// concurrent workers never race over one script counter. Sequential scenarios
// keep the single fixture child they were written against.
const promptText = () => {
  const args = process.argv.slice(2);
  let text = args.join("\\n");
  for (const arg of args) {
    try { if (arg.endsWith(".md")) text += "\\n" + readFileSync(arg, "utf8"); } catch {}
  }
  return text;
};
const promptChild = process.env.CONFORMANCE_CHILD_FROM_PROMPT ? (/Cook exactly \`([^\`]+)\`/.exec(promptText()) ?? [])[1] ?? null : null;
const child = process.env.COOKEPIC_CHILD ?? promptChild ?? process.env.CONFORMANCE_CHILD_ID ?? state.children[0]?.id;
const scripted = state.agentScript.filter((entry) => entry.childId === child);
state.agentInvocations = state.agentInvocations ?? {};
const index = scripted.length > 0 ? (state.agentInvocations[child] ?? 0) : state.agentInvocation;
if (scripted.length > 0) state.agentInvocations[child] = index + 1; else state.agentInvocation = index + 1;
const step = scripted.length > 0 ? (scripted[index] ?? scripted.at(-1)) : (state.agentScript[index] ?? state.agentScript.at(-1));
if (!step) throw new Error("agent script is empty");
writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
appendFileSync(journal, JSON.stringify({ tool: "agent", harness: process.env.CONFORMANCE_HARNESS ?? basename(process.argv[1]), invocation: index, child, argv: process.argv.slice(2), step }) + "\\n");
rmdirSync(lock);
ownsLock = false;
if (step.hangMs > 0) sleep(step.hangMs);
const commitEnv = { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
if (step.mergeBaseBranch) {
  const baseCwd = process.env.CONFORMANCE_BASE_CWD;
  if (!baseCwd) throw new Error("mergeBaseBranch needs CONFORMANCE_BASE_CWD");
  const head = spawnSync("git", ["-C", baseCwd, "rev-parse", "HEAD"], { encoding: "utf8", env: process.env });
  if (head.status !== 0) process.exit(head.status ?? 1);
  // A conflict here is the expected outcome, so the exit code is not checked:
  // the writes below resolve it and the commit below records the resolution.
  spawnSync("git", ["merge", "--no-edit", head.stdout.trim()], { stdio: "inherit", env: commitEnv });
}
if (step.claimChild && child) {
  const result = spawnSync("bd", ["update", child, "--claim"], { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const file of step.writes ?? []) {
  const target = resolve(process.cwd(), file.path);
  if (!target.startsWith(process.cwd() + sep)) throw new Error("agent write escapes repo");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.content);
}
if ((step.repoAction === "dirty-only" || step.repoAction === "commit" || step.repoAction === "commit-with-siblings") && (step.writes?.length ?? 0) === 0) {
  writeFileSync("agent-" + String(index) + ".txt", "agent " + String(index) + "\\n");
}
if (step.repoAction === "commit" || step.repoAction === "commit-with-siblings") {
  for (const args of [["add", "."], ["commit", "-qm", "fixture agent commit " + String(index) + " for " + String(child)]]) {
    const result = spawnSync("git", args, { stdio: "inherit", env: commitEnv });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const baseCwd = process.env.CONFORMANCE_BASE_CWD;
  if (step.advanceBase && state.mergeConflict && baseCwd && resolve(process.cwd()) !== resolve(baseCwd)) {
    const baseTarget = resolve(baseCwd, state.mergeConflict.path);
    if (!baseTarget.startsWith(resolve(baseCwd) + sep)) throw new Error("merge conflict path escapes base repo");
    mkdirSync(dirname(baseTarget), { recursive: true });
    writeFileSync(baseTarget, state.mergeConflict.baseAdvanceContent);
    for (const args of [["-C", baseCwd, "add", "."], ["-C", baseCwd, "commit", "-qm", "fixture base advance " + String(index)]]) {
      const result = spawnSync("git", args, { stdio: "inherit", env: commitEnv });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
  if (step.repoAction === "commit-with-siblings") {
    for (const sibling of state.siblingRepos) {
      const siblingPath = resolve(process.cwd(), "..", basename(sibling));
      writeFileSync(join(siblingPath, "agent-" + String(index) + ".txt"), "agent " + String(index) + "\\n");
      for (const args of [["-C", siblingPath, "add", "."], ["-C", siblingPath, "commit", "-qm", "fixture sibling commit " + String(index)]]) {
        const result = spawnSync("git", args, { stdio: "inherit", env: commitEnv });
        if (result.status !== 0) process.exit(result.status ?? 1);
      }
    }
  }
}
if (step.closeChild) {
  if (child) spawnSync("bd", ["close", child, "--reason", "fixture completed"], { stdio: "inherit", env: process.env });
}
if (step.beadComment !== undefined) {
  if (child) spawnSync("bd", ["comment", child, step.beadComment], { stdio: "inherit", env: process.env });
}
const harness = process.env.CONFORMANCE_HARNESS ?? basename(process.argv[1]);
const text = step.report._tag === "ralph-done" ? "RALPH_DONE" : step.report._tag === "ralph-blocked" ? "RALPH_BLOCKED" : step.report._tag === "ralph-msg" ? "RALPH_MSG: " + JSON.stringify({ summary: step.report.summary, why: step.report.why }) : null;
if (step.report._tag === "provider-error") {
  console.log(JSON.stringify({ type: "error", error: { message: step.report.message } })); process.exit(1);
}
if (step.report._tag === "permission-denial") {
  console.log(JSON.stringify({ type: "result", is_error: true, result: step.report.message, permission_denials: [{ message: step.report.message }] })); process.exit(1);
}
if (text !== null) {
  if (harness === "claude" || harness === "ccx") console.log(JSON.stringify({ type: "result", result: text, session_id: "fixture-session" }));
  else if (harness === "kimi") { console.log(JSON.stringify({ role: "assistant", content: text })); console.log(JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "fixture-session" })); }
  else if (harness === "codex") { console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-session" })); console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })); }
  else if (harness === "opencode") { console.log(JSON.stringify({ type: "text", sessionID: "fixture-session", part: { type: "text", text } })); console.log(JSON.stringify({ type: "step_finish", part: { reason: "stop" } })); }
  else console.log(text);
}
`;
