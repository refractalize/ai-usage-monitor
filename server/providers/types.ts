import type { JsonObject, NormalizedSnapshot } from '../models.ts';

export interface ProviderAdapter {
  read(options: { signal?: AbortSignal }): Promise<JsonObject>;
  normalize(response: JsonObject): NormalizedSnapshot;
}
