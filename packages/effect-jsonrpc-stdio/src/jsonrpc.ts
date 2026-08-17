import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const JsonRpcId = Schema.Union([Schema.Number, Schema.String]);
export const JsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export const JsonRpcRequestEnvelope = <A, I>(method: string, params: Schema.Codec<A, I>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: JsonRpcId,
    method: Schema.Literal(method),
    params,
  });
export const JsonRpcNotificationEnvelope = <A, I>(method: string, params: Schema.Codec<A, I>) =>
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), method: Schema.Literal(method), params });
export const JsonRpcResponseEnvelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: JsonRpcId,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcError),
});

export const encodeJsonl = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.map((encoded) => `${encoded}\n`),
  );

export const decodeJsonl = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
