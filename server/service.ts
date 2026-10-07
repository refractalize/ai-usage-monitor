import { adapterFor, type ProviderAdapter } from './adapters.ts';
import { Store } from './database.ts';
import { CollectionError } from './models.ts';
import { DEFAULT_SCOPE, type Provider, providerName, type Scope, scopeFor } from './providers.ts';

// The runtime owns the single database instance; Vite route reloads reuse it.
const state = globalThis as typeof globalThis & { aiUsageStore?: Store };
export function getStore() {
  state.aiUsageStore ??= new Store();
  return state.aiUsageStore;
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
  try {
    const response = await adapter.read({ signal });
    const inserted = store.save(adapter.normalize(response), Date.now() / 1000, scope);
    store.attempt(at, true, inserted ? 'Snapshot saved.' : 'Duplicate skipped.', scope);
    console.error(
      `${providerName(scope.provider)}: ${inserted ? 'usage snapshot saved.' : 'duplicate snapshot skipped.'}`,
    );
  } catch (error) {
    const message = safeError(error);
    try {
      store.attempt(at, false, message, scope);
    } catch {
      /* Disk failures still reach stderr. */
    }
    throw new CollectionError(message);
  }
}

// A rejected provider must not prevent another provider from collecting.
export async function collectProviders(store: Store, providers: Provider[], signal?: AbortSignal) {
  return Promise.allSettled(
    providers.map((provider) => collect(store, signal, scopeFor(provider))),
  );
}
