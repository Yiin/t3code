/**
 * fetchMock - build a `FetchHttpClient.Fetch` double.
 *
 * `FetchHttpClient.Fetch` is a `Context.Reference<typeof globalThis.fetch>`, and
 * Bun's types add a `preconnect` property to that type. A bare arrow is therefore
 * not assignable to it. Attaching a no-op `preconnect` keeps the mock honest
 * instead of casting it into shape.
 *
 * @module fetchMock
 */

/** The call signature of `fetch`, without the Bun-only `preconnect` property. */
export type FetchSend = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>;

const preconnect: typeof globalThis.fetch.preconnect = () => {};

/** Wrap a plain request handler as a complete `fetch` implementation. */
export const makeFetchMock = (send: FetchSend): typeof globalThis.fetch =>
  Object.assign(send, { preconnect });
