import { adapterFor, type ProviderAdapter } from './adapters.ts';
import { Store } from './database.ts';
import { describeWindows, duration, log } from './log.ts';
import { CollectionError } from './models.ts';
import {
  DEFAULT_SCOPE,
  enabledProviders,
  type Provider,
  providerName,
  type Scope,
  scopeFor,
} from './providers.ts';

// The runtime owns the single database instance; Vite route reloads reuse it.
// globalThis also bridges the production route bundle, which has its own module copies.
export interface Collection {
  providers: Provider[];
  scheduled: boolean;
}
const state = globalThis as typeof globalThis & {
  aiUsageStore?: Store;
  aiUsageCollection?: Collection;
};
export function getStore() {
  state.aiUsageStore ??= new Store();
  return state.aiUsageStore;
}
// What the running server actually collects, so the dashboard cannot disagree with it.
export function setCollection(collection: Collection) {
  state.aiUsageCollection = collection;
}
export function getCollection(): Collection {
  return state.aiUsageCollection ?? { providers: enabledProviders(), scheduled: false };
}
export function safeError(error: unknown) {
  return error instanceof CollectionError
    ? error.message
    : 'Collection failed; check database permissions, disk space, and configuration.';
}
export async function collect(
  store: Store,
  signal?: AbortSignal,
  scope: Scope = DEFAULT_SCOPE,
  adapter: ProviderAdapter = adapterFor(scope.provider),
) {
  const at = Date.now() / 1000;
  const started = performance.now();
  const name = providerName(scope.provider);
  try {
    const response = await adapter.read({ signal });
    const snapshot = adapter.normalize(response);
    const inserted = store.save(snapshot, Date.now() / 1000, scope);
    store.attempt(at, true, inserted ? 'Snapshot saved.' : 'Duplicate skipped.', scope);
    log(
      `${name}: ${inserted ? 'snapshot saved' : 'unchanged, duplicate skipped'} in ${duration(performance.now() - started)}; ${describeWindows(snapshot.windows)}`,
    );
  } catch (error) {
    const message = safeError(error);
    try {
      store.attempt(at, false, message, scope);
    } catch {
      /* Disk failures still reach stderr. */
    }
    // Unexpected errors are hidden from the dashboard but the operator needs the cause.
    const cause =
      error instanceof CollectionError || !(error instanceof Error)
        ? ''
        : ` (${error.name}: ${error.message})`;
    const kind =
      error instanceof CollectionError && error.kind === 'rate_limited' ? ' [rate limited]' : '';
    log(
      `${name}: collection failed${kind} after ${duration(performance.now() - started)}: ${message}${cause}`,
    );
    throw error instanceof CollectionError ? error : new CollectionError(message);
  }
}

// A rejected provider must not prevent another provider from collecting.
export async function collectProviders(store: Store, providers: Provider[], signal?: AbortSignal) {
  return Promise.allSettled(
    providers.map((provider) => collect(store, signal, scopeFor(provider))),
  );
}
