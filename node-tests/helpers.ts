import { adapterFor } from '../server/adapters.ts';
import { Store } from '../server/database.ts';
import type { JsonObject } from '../server/models.ts';
import { DEFAULT_SCOPE, type Scope } from '../server/providers.ts';

// Fixture convenience; production storage only accepts normalized observations.
export class FixtureStore extends Store {
  saveRaw(response: JsonObject, at?: number, scope: Scope = DEFAULT_SCOPE) {
    return this.save(adapterFor(scope.provider).normalize(response), at, scope);
  }
}
