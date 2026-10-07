import { claudeAdapter } from './providers/claude/index.ts';
import { codexAdapter } from './providers/codex/index.ts';
import type { ProviderAdapter } from './providers/types.ts';
import type { Provider } from './providers.ts';

export type { ProviderAdapter } from './providers/types.ts';

// Static registration: no runtime plugin loading or external code discovery.
export const adapters = {
  codex: codexAdapter,
  claude: claudeAdapter,
} satisfies Record<Provider, ProviderAdapter>;
export const adapterFor = (provider: Provider): ProviderAdapter => adapters[provider];
