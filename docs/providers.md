# Adding a provider

Providers are compiled into the application. There is no plugin loader.

1. Add browser-safe name, freshness label, and optional notice to
   `providerMetadata` in `server/providers.ts`. Its keys define the provider type
   and populate validation, CLI help, `--provider all`, and dashboard tabs.
2. Create `server/providers/<provider>/` for its transport, models, and adapter
   (`index.ts`). Implement a read-only collector using the provider's normal authentication.
   It must support cancellation and a bounded timeout, clean up subprocesses,
   and never submit a prompt or start inference. Use `CollectionError` with safe,
   fixed messages: never include remote error bodies, tokens, or account details.
3. Implement the `ProviderAdapter` contract from `server/providers/types.ts` and
   register the adapter in `server/adapters.ts`.
   TypeScript requires an adapter for every metadata entry. Return:
   - `raw_response`: complete structured response, retained privately in SQLite.
   - `windows`: common allowance records from `server/models.ts`, using UTC epoch
     seconds for resets and minutes for duration. Missing metadata stays null.
   - `deduplication_value`: stable quota payload excluding request IDs, session
     timers, and other volatile transport metadata. Preserve unknown quota fields.
4. Add synthetic tests for parsing, missing fields, renamed windows, errors,
   cancellation, and protocol requests. Test that no model request is sent.
5. Document the login flow and add the CLI installation/auth volume to Docker if
   necessary. Pin versions when depending on experimental protocols.

Storage takes only normalized snapshots. Collection orchestration selects an
adapter, records successful snapshots or sanitized failure attempts, and leaves
other providers running on failure. Each enabled provider has its own five-minute
scheduler. Analytics isolate provider, account name, and allowance; they never
sum unrelated allowances. Do not guess durations for unknown windows.

The account environment variable follows `<PROVIDER_ID>_USAGE_ACCOUNT_NAME` (uppercase).
Account names are operator-supplied, not detected from authentication. Provider
selection uses `USAGE_PROVIDERS`; Compose explicitly enables the bundled providers.
Local commands default to the first registered provider.

Metadata is separate from server adapters so Node subprocess code and credential
handling cannot be imported into the browser bundle. Raw responses are available
through the private database/CLI export only, never the dashboard loader.
