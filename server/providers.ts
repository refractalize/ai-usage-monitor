import { CollectionError } from './models.ts';

// Browser-safe metadata. Server adapters are checked against these keys.
export interface ProviderInfo {
  name: string;
  freshnessLabel: string;
  notice: string | null;
}
export const providerMetadata = {
  codex: { name: 'Codex', freshnessLabel: 'Up to date', notice: null },
  claude: {
    name: 'Claude',
    freshnessLabel: 'Recently collected',
    notice:
      'Claude support is experimental. Readings may come from the CLI’s cache; collection time does not guarantee upstream freshness.',
  },
} satisfies Record<string, ProviderInfo>;
export type Provider = keyof typeof providerMetadata;
export const PROVIDERS = Object.keys(providerMetadata) as Provider[];
export interface Scope {
  provider: Provider;
  account: string;
}
export const DEFAULT_SCOPE: Scope = { provider: PROVIDERS[0], account: 'default' };
export function providerInfo(provider: Provider): ProviderInfo {
  return providerMetadata[provider];
}
export function providerName(provider: Provider) {
  return providerInfo(provider).name;
}
export function parseProvider(value: string): Provider {
  if (!PROVIDERS.includes(value as Provider))
    throw new CollectionError(`Provider must be one of: ${PROVIDERS.join(', ')}.`);
  return value as Provider;
}
export function scopeFor(provider: Provider): Scope {
  return {
    provider,
    account: process.env[`${provider.toUpperCase()}_USAGE_ACCOUNT_NAME`] || 'default',
  };
}
export function enabledProviders(): Provider[] {
  return [
    ...new Set(
      (process.env.USAGE_PROVIDERS ?? PROVIDERS[0]).split(',').map((v) => parseProvider(v.trim())),
    ),
  ];
}
