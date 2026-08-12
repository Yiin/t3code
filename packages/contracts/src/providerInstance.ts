/**
 * Provider-instance contracts.
 *
 * Splits the historical "provider kind" concept into two:
 *
 *   - `ProviderDriverKind` is the implementation kind selector (e.g. codex,
 *     claudeAgent, a fork's `ollama`, …). It picks which driver package
 *     handles the protocol, the probe, the adapter, and text generation.
 *
 *   - `ProviderInstanceId` is the routing key (a user-defined slug).
 *     Threads, sessions, runtime events, and persisted bindings reference
 *     instance ids — never driver kinds — so a user can configure multiple
 *     instances of the same driver (e.g. `codex_personal` + `codex_work`),
 *     each with independent driver-specific configuration.
 *
 * Forward/backward compatibility invariant
 * ----------------------------------------
 * `ProviderDriverKind` is intentionally an **open** branded slug, not a closed
 * literal union. The server hosts forks, ships in PRs that add drivers, and
 * users frequently roll between branches and forks. Any of those paths can
 * leave `ServerSettings`, persisted thread state, or session bindings
 * referencing a driver that the currently-running build does not know about.
 *
 * The rule: parsing any of those payloads must always succeed, and the
 * runtime is responsible for marking the unknown driver/instance as
 * "unavailable" rather than crashing. Built-in drivers shipped by the core
 * product happens to register in a given build is not part of the contract
 * layer. Driver availability is discovered through the runtime registry.
 *
 * Driver-specific configuration is similarly opaque at the contracts layer:
 * drivers live in (or will be extracted to) their own packages and own their
 * config schemas. The contracts package only knows the envelope.
 *
 * @module providerInstance
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
/**
 * Slug pattern shared by driver kinds and instance ids — letters, digits,
 * dashes, underscores. The first character must be a letter so slugs remain
 * JS-identifier friendly when used as object keys, log fields, or telemetry
 * attributes. Mixed case is permitted so historical driver kinds (e.g.
 * `claudeAgent`) can be used verbatim during the migration and so external
 * fork authors retain reasonable freedom.
 */
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

/**
 * `ProviderDriverKind` — open branded slug naming a driver implementation.
 *
 * Constraints (validated at the schema layer):
 *   - starts with a letter
 *   - only letters, digits, `-`, `_` after the first char
 *   - 1..64 characters
 *
 * Notably **not** validated: that the driver is one we know how to load.
 * That check belongs to the runtime registry, which downgrades unknown
 * drivers gracefully (see module docs).
 */
export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

/** Canonical driver slug for the first-party Prime Agent provider. */
export const PRIME_AGENT_DRIVER_KIND = ProviderDriverKind.make("primeAgent");

/**
 * First-party provider kinds with legacy settings slots.
 *
 * This catalog is safe to import in browser code. Runtime driver availability
 * remains a server concern and must not be inferred from this list.
 */
export const BUILT_IN_PROVIDER_DRIVER_KINDS: ReadonlyArray<ProviderDriverKind> = [
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("cursor"),
  ProviderDriverKind.make("grok"),
  ProviderDriverKind.make("kimi"),
  ProviderDriverKind.make("opencode"),
  PRIME_AGENT_DRIVER_KIND,
];

const isProviderDriverKindValue = Schema.is(ProviderDriverKind);
export const isProviderDriverKind = (value: unknown): value is ProviderDriverKind =>
  isProviderDriverKindValue(value);

/**
 * `ProviderInstanceId` — user-defined routing key for a configured provider
 * instance. Same slug rules as `ProviderDriverKind`; branded separately so the
 * type system cannot confuse the two.
 */
export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

/**
 * Lightweight reference identifying which driver implements an instance.
 * Carried alongside `ProviderInstanceId` on wire shapes so consumers can
 * branch on driver behavior (icons, capabilities, presentation) without
 * having to look up the instance in the registry.
 */
export const ProviderInstanceRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type ProviderInstanceRef = typeof ProviderInstanceRef.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

export const ProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

/**
 * Envelope shape for a provider instance configuration in `ServerSettings`.
 *
 * `driver` is intentionally accepted as any well-formed slug (see module
 * docs). The driver-specific config payload is left as `Schema.Unknown`;
 * each driver registers its own decoder with the runtime registry, and
 * envelopes for unknown drivers are preserved verbatim so they round-trip
 * across version changes without data loss.
 */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

/**
 * Map shape for `ServerSettings.providerInstances`. Keyed by
 * `ProviderInstanceId`, values are envelopes the registry feeds to drivers.
 */
export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/**
 * Construct the canonical `ProviderInstanceId` used as a back-compat default
 * for a built-in driver. The legacy single-instance-per-driver world used
 * the driver kind itself as the instance id; preserving that mapping keeps
 * existing persisted threads, bindings, and cache files routable across the
 * migration without rewriting their stored selection payloads.
 */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);

/**
 * How a driver takes one class of attachment.
 *
 *   - `native`: the driver's own protocol carries the attachment, so the
 *     model sees its content without touching the disk.
 *   - `path-reference`: the driver gets the absolute path plus an instruction
 *     to read it. The model still reaches the content, one tool call later.
 *   - `unsupported`: the driver cannot take the attachment at all. A composer
 *     should refuse the file before the user uploads it.
 */
export const ProviderAttachmentSupport = Schema.Literals([
  "native",
  "path-reference",
  "unsupported",
]);
export type ProviderAttachmentSupport = typeof ProviderAttachmentSupport.Type;

/**
 * What one driver can do with the two attachment classes a chat can carry.
 *
 * A mime list names the types handled at the declared support level; `null`
 * means every type of that class is handled there. A type outside a non-null
 * list is not refused. The driver's encoder falls back to whatever it can do
 * for that type. Only `unsupported` means "refuse it".
 */
export interface ProviderAttachmentCapability {
  readonly images: ProviderAttachmentSupport;
  /** `null` = any `image/*`. */
  readonly imageMimeTypes: ReadonlyArray<string> | null;
  readonly files: ProviderAttachmentSupport;
  /** `null` = any mime type. */
  readonly fileMimeTypes: ReadonlyArray<string> | null;
}

/**
 * Conservative capability for a driver this build does not know about (a fork's
 * driver, or one from a newer branch). Images stay native because every driver
 * this product has ever shipped takes them; files are refused because an
 * unknown protocol has no path we can trust.
 */
export const UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY: ProviderAttachmentCapability = {
  images: "native",
  imageMimeTypes: null,
  files: "unsupported",
  fileMimeTypes: null,
};

/** Image types the Claude Agent SDK carries as an image block. */
const CLAUDE_AGENT_IMAGE_MIME_TYPES: ReadonlyArray<string> = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
];

/**
 * File types the Claude Agent SDK carries as a document block: PDF through a
 * base64 source, plain text through a text source. Anything else falls back to
 * the absolute path.
 */
const CLAUDE_AGENT_FILE_MIME_TYPES: ReadonlyArray<string> = ["application/pdf", "text/plain"];

/**
 * Per-driver attachment support for the built-in drivers.
 *
 * Seeded from the six-provider probe in `t3code-vzb.33`, which ran live turns
 * against Claude, Codex, Grok and Kimi and read the official sources for Cursor
 * and Prime. Keep this table and each adapter's declared
 * `capabilities.attachments` equal; a server test asserts they match.
 *
 * This is static data and safe to import in browser code. It says what a
 * driver's protocol can express, never whether the driver is installed.
 */
const BUILT_IN_DRIVER_ATTACHMENT_CAPABILITIES: Readonly<
  Record<string, ProviderAttachmentCapability>
> = {
  // The app-server input union has no file member, so a file rides as text
  // naming the absolute path. Images have their own member.
  codex: { images: "native", imageMimeTypes: null, files: "path-reference", fileMimeTypes: null },
  claudeAgent: {
    images: "native",
    imageMimeTypes: CLAUDE_AGENT_IMAGE_MIME_TYPES,
    files: "native",
    fileMimeTypes: CLAUDE_AGENT_FILE_MIME_TYPES,
  },
  // Cursor drops the content of any resource outside the workspace, so a file
  // reaches it only as a path into a copy materialized under the workspace.
  cursor: { images: "native", imageMimeTypes: null, files: "path-reference", fileMimeTypes: null },
  // Grok and Kimi both read an ACP `resource_link` to an absolute path.
  grok: { images: "native", imageMimeTypes: null, files: "native", fileMimeTypes: null },
  kimi: { images: "native", imageMimeTypes: null, files: "native", fileMimeTypes: null },
  // OpenCode already sends a `file` part carrying mime, filename and url.
  opencode: { images: "native", imageMimeTypes: null, files: "native", fileMimeTypes: null },
  // Prime's kernel reads the absolute path once the runtime mode allows it.
  primeAgent: {
    images: "native",
    imageMimeTypes: null,
    files: "path-reference",
    fileMimeTypes: null,
  },
};

/**
 * Attachment support for a driver. Unknown drivers get
 * {@link UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY}.
 */
export const attachmentCapabilityForDriver = (
  driver: ProviderDriverKind,
): ProviderAttachmentCapability =>
  BUILT_IN_DRIVER_ATTACHMENT_CAPABILITIES[driver] ?? UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY;
