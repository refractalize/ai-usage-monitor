import type { ProviderAdapter } from '../types.ts';
import { readRateLimits } from './appserver.ts';
import { parseWindows } from './models.ts';

export const codexAdapter: ProviderAdapter = {
  read: readRateLimits,
  normalize: (response) => ({
    raw_response: response,
    windows: parseWindows(response),
    deduplication_value: response.result,
  }),
};
