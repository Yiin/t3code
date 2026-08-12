import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@t3tools/shared/hostProcess/HostProcessPlatform",
  {
    defaultValue: () => process.platform,
  },
);

/**
 * The one-minute load average, as a sampler rather than a reading.
 *
 * Load changes while a process runs, so a caller that wants to know whether the
 * host is busy has to sample it more than once. On Windows `os.loadavg()`
 * returns zeros, which reads as an idle host and disables any load-aware wait.
 */
export const HostProcessLoadAverage = Context.Reference<() => number>(
  "@t3tools/shared/hostProcess/HostProcessLoadAverage",
  {
    defaultValue: () => () => NodeOS.loadavg()[0] ?? 0,
  },
);

/** Cores this process may actually use, honouring an affinity mask or cgroup. */
export const HostProcessCpuCount = Context.Reference<number>(
  "@t3tools/shared/hostProcess/HostProcessCpuCount",
  {
    defaultValue: () => NodeOS.availableParallelism(),
  },
);

export const HostProcessArchitecture = Context.Reference<NodeJS.Architecture>(
  "@t3tools/shared/hostProcess/HostProcessArchitecture",
  {
    defaultValue: () => process.arch,
  },
);

export const HostProcessHostname = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessHostname",
  {
    defaultValue: () => NodeOS.hostname(),
  },
);

export const HostProcessEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "@t3tools/shared/hostProcess/HostProcessEnvironment",
  {
    defaultValue: () => process.env,
  },
);

export const HostProcessExecutablePath = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const HostProcessArguments = Context.Reference<ReadonlyArray<string>>(
  "@t3tools/shared/hostProcess/HostProcessArguments",
  {
    defaultValue: () => process.argv,
  },
);

export const isHostWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
