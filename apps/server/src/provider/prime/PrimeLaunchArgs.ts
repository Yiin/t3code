const RESERVED_PRIME_FLAGS = new Set([
  "--mode",
  "--session",
  "--session-id",
  "--session-dir",
  "--fork",
  "--continue",
  "--resume",
  "--no-session",
  "--provider",
  "--model",
  "--thinking",
  "--extension",
  "-e",
  "--no-extensions",
]);

export function findReservedPrimeLaunchArg(args: ReadonlyArray<string>): string | undefined {
  return args.find(
    (arg) =>
      RESERVED_PRIME_FLAGS.has(arg) ||
      [...RESERVED_PRIME_FLAGS].some((flag) => arg.startsWith(`${flag}=`)),
  );
}
