import Mime from "@effect/platform-node/Mime";
import {
  type AttachmentUploadResponse,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
} from "@t3tools/contracts";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import { createUploadId, resolveUploadPath, writeUploadMeta } from "./attachmentStore.ts";
import { ATTACHMENT_MIME_TYPE_PATTERN } from "./orchestration/Normalizer.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const ATTACHMENT_UPLOAD_PATH = "/api/attachments";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    return HttpRouter.cors({
      ...(devOrigin
        ? { allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS], credentials: true }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export class AttachmentUploadTooLargeError extends Data.TaggedError(
  "AttachmentUploadTooLargeError",
)<{}> {}

/**
 * Fails the stream the moment the running byte count passes `maxBytes`, and
 * reports every count to `onCount`. Content-Length can lie or be absent, so
 * this — not the declared header — is what actually bounds what lands on disk.
 */
export const capAttachmentUploadStream = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
  onCount: (bytes: number) => void,
): Stream.Stream<Uint8Array, E | AttachmentUploadTooLargeError, R> => {
  let bytesSeen = 0;
  return stream.pipe(
    Stream.mapEffect((chunk) => {
      bytesSeen += chunk.byteLength;
      onCount(bytesSeen);
      return bytesSeen > maxBytes
        ? Effect.fail(new AttachmentUploadTooLargeError())
        : Effect.succeed(chunk);
    }),
  );
};

/**
 * Decodes the percent-encoded `X-Attachment-Name` header. Returns `undefined`
 * for a missing, empty, or malformed value so the route answers 400.
 */
export function decodeAttachmentNameHeader(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

class AttachmentUploadMetaWriteError extends Data.TaggedError("AttachmentUploadMetaWriteError")<{
  readonly cause: unknown;
}> {}

/**
 * `POST /api/attachments` — streams one attachment straight to the staging
 * area (see attachmentStore.ts) ahead of the turn that references it by
 * `uploadId`, so a multi-hundred-MB file never has to ride the WebSocket
 * send-turn frame as a base64 data URL. The dataUrl path in the orchestration
 * contract still exists for small/legacy attachments; this route is additive.
 */
export const attachmentUploadRouteLayer = HttpRouter.add(
  "POST",
  ATTACHMENT_UPLOAD_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);

    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // The header is percent-encoded by the client (an XHR request header is a
    // ByteString, so a name like `ataskaita_ž.pdf` cannot ride it raw). A
    // malformed escape decodes to nothing and falls into the 400 below.
    const name = decodeAttachmentNameHeader(request.headers["x-attachment-name"]);
    const mimeType = request.headers["content-type"]?.trim().toLowerCase();
    const contentLengthHeader = request.headers["content-length"];
    const declaredLength =
      contentLengthHeader !== undefined ? Number(contentLengthHeader) : undefined;

    if (!name || name.length === 0 || name.length > 255) {
      return HttpServerResponse.text("Missing or invalid X-Attachment-Name header.", {
        status: 400,
      });
    }
    if (!mimeType || !ATTACHMENT_MIME_TYPE_PATTERN.test(mimeType)) {
      return HttpServerResponse.text("Missing or invalid Content-Type header.", { status: 415 });
    }
    if (declaredLength !== undefined && !Number.isFinite(declaredLength)) {
      return HttpServerResponse.text("Invalid Content-Length header.", { status: 400 });
    }
    if (declaredLength !== undefined && declaredLength <= 0) {
      return HttpServerResponse.text("Attachment is empty.", { status: 400 });
    }
    if (declaredLength !== undefined && declaredLength > PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES) {
      return HttpServerResponse.text("Attachment exceeds the maximum upload size.", {
        status: 413,
      });
    }

    const uploadId = createUploadId();
    const binPath = resolveUploadPath({
      attachmentsDir: serverConfig.attachmentsDir,
      uploadId,
      extension: "bin",
    });
    if (!binPath) {
      return HttpServerResponse.text("Failed to stage the upload.", { status: 500 });
    }

    const stagingDirResult = yield* fileSystem
      .makeDirectory(path.dirname(binPath), { recursive: true })
      .pipe(Effect.result);
    if (stagingDirResult._tag === "Failure") {
      return HttpServerResponse.text("Failed to stage the upload.", { status: 500 });
    }

    let bytesWritten = 0;
    const cappedStream = capAttachmentUploadStream(
      request.stream,
      PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
      (bytes) => {
        bytesWritten = bytes;
      },
    );

    // A client that aborts mid-body interrupts this fiber rather than failing
    // it, and `Effect.result` only captures failures. Without the
    // `onInterrupt` the half-written `.bin` would survive with no sibling
    // `.json`. The web Remove button aborts the XHR, so this is a hot path.
    const writeResult = yield* Stream.run(cappedStream, fileSystem.sink(binPath)).pipe(
      Effect.onInterrupt(() => fileSystem.remove(binPath, { force: true }).pipe(Effect.ignore)),
      Effect.result,
    );
    if (writeResult._tag === "Failure") {
      yield* fileSystem.remove(binPath, { force: true }).pipe(Effect.ignore);
      if (writeResult.failure._tag === "AttachmentUploadTooLargeError") {
        return HttpServerResponse.text("Attachment exceeds the maximum upload size.", {
          status: 413,
        });
      }
      return HttpServerResponse.text("Failed to read the attachment body.", { status: 400 });
    }

    if (bytesWritten === 0) {
      yield* fileSystem.remove(binPath, { force: true }).pipe(Effect.ignore);
      return HttpServerResponse.text("Attachment is empty.", { status: 400 });
    }
    if (declaredLength !== undefined && declaredLength !== bytesWritten) {
      yield* fileSystem.remove(binPath, { force: true }).pipe(Effect.ignore);
      return HttpServerResponse.text("Content-Length did not match the uploaded bytes.", {
        status: 400,
      });
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const metaWriteResult = yield* Effect.try({
      try: () =>
        writeUploadMeta({
          attachmentsDir: serverConfig.attachmentsDir,
          uploadId,
          meta: { name, mimeType, sizeBytes: bytesWritten, createdAt },
        }),
      catch: (cause) => new AttachmentUploadMetaWriteError({ cause }),
    }).pipe(Effect.result);
    if (metaWriteResult._tag === "Failure") {
      yield* fileSystem.remove(binPath, { force: true }).pipe(Effect.ignore);
      return HttpServerResponse.text("Failed to stage the upload.", { status: 500 });
    }

    const responseBody: AttachmentUploadResponse = {
      uploadId,
      name,
      mimeType,
      sizeBytes: bytesWritten,
    };
    return HttpServerResponse.jsonUnsafe(responseBody, { status: 201 });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
