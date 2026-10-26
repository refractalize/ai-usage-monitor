import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectionError, type JsonObject, object } from '../../models.ts';
import { type RpcTransport, runStdio } from '../../stdio.ts';
import { claudeResult, usageFetchError, usageFetched } from './models.ts';

export async function waitForControlResponse(
  transport: RpcTransport,
  id: string,
): Promise<JsonObject> {
  for (;;) {
    const message = await transport.receive();
    if (
      message.type !== 'control_response' ||
      !object(message.response) ||
      message.response.request_id !== id
    )
      continue;
    if (message.response.subtype !== 'success') {
      // Never forward backend error bodies: they may contain account details or credentials.
      throw new CollectionError(
        'Claude rejected the usage request. Check claude auth status, network access, and CLI compatibility.',
      );
    }
    if (!object(message.response.response))
      throw new CollectionError('Claude returned an invalid control response.');
    return message;
  }
}
export async function initializeAndReadClaude(transport: RpcTransport) {
  transport.send({
    type: 'control_request',
    request_id: 'init',
    request: {
      subtype: 'initialize',
      hooks: {},
      sdkMcpServers: [],
      promptSuggestions: false,
    },
  });
  await waitForControlResponse(transport, 'init');
  transport.send({
    type: 'control_request',
    request_id: 'usage',
    request: {
      subtype: 'get_usage',
      skip_behaviors: true,
    },
  });
  return waitForControlResponse(transport, 'usage');
}
// Verified against Claude Code 2.1.310. This is an experimental control API.
// No user message, prompt, model turn, transcript scan, or direct HTTP request.
export async function readClaudeUsage(
  options: { claude?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-usage-'));
  // Private to the temp directory and removed with it; read to verify and classify the fetch.
  const debugLog = join(cwd, 'debug.log');
  try {
    const response = await runStdio(
      {
        executable: options.claude ?? process.env.CLAUDE_BIN ?? 'claude',
        name: 'Claude Code',
        cwd,
        args: [
          '--print',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--no-session-persistence',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--setting-sources',
          '',
          '--settings',
          '{"disableAllHooks":true}',
          '--tools',
          '',
          '--debug-file',
          debugLog,
        ],
        env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        accept: (message) =>
          message.type === 'control_response' &&
          object(message.response) &&
          ['init', 'usage'].includes(message.response.request_id as string),
      },
      initializeAndReadClaude,
    );
    const result = claudeResult(response);
    let text = '';
    try {
      text = readFileSync(debugLog, 'utf8');
    } catch {
      /* Treated as an unverified or unexplained read below. */
    }
    if (result.rate_limits_available === true && result.rate_limits == null)
      throw usageFetchError(text);
    // Only accept limits this process fetched, never a replayed or cached reading.
    if (!usageFetched(text))
      throw new CollectionError(
        'Claude returned usage limits without fetching them in this run; refusing a possibly cached reading.',
      );
    return response;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
