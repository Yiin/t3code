/** Per-instance Prime Agent adapter contract. */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PrimeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
