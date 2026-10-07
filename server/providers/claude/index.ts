import type { ProviderAdapter } from '../types.ts';
import { claudeResult, parseClaudeWindows } from './models.ts';
import { readClaudeUsage } from './transport.ts';

export const claudeAdapter: ProviderAdapter = {
  read: readClaudeUsage,
  normalize: (response) => {
    const windows = parseClaudeWindows(response);
    const result = claudeResult(response);
    return {
      raw_response: response,
      windows,
      // Session timers vary on every read; quota metadata determines duplicates.
      deduplication_value: {
        subscription_type: result.subscription_type,
        rate_limits_available: result.rate_limits_available,
        rate_limits: result.rate_limits,
      },
    };
  },
};
