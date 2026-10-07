import { CollectionError, type JsonObject, object } from '../../models.ts';
import { type RpcTransport, runStdio } from '../../stdio.ts';

export type { RpcTransport } from '../../stdio.ts';

export async function waitForResponse(transport: RpcTransport, id: number): Promise<JsonObject> {
  for (;;) {
    const message = await transport.receive();
    if ('method' in message || message.id !== id) continue;
    if ('error' in message) {
      const code =
        object(message.error) && Number.isSafeInteger(message.error.code)
          ? ` (code ${message.error.code})`
          : '';
      throw new CollectionError(
        `Codex rejected the request${code}. Check codex login status, network access, and Codex compatibility.`,
      );
    }
    if (!object(message.result))
      throw new CollectionError('Codex response is missing an object result.');
    return message;
  }
}
export async function handshakeAndRead(transport: RpcTransport) {
  transport.send({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'ai_usage_monitor', title: 'AI Usage Monitor', version: '0.2.0' },
    },
  });
  await waitForResponse(transport, 1);
  transport.send({ method: 'initialized' });
  transport.send({ id: 2, method: 'account/rateLimits/read' });
  return waitForResponse(transport, 2);
}

export async function readRateLimits(
  options: { codex?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return runStdio(
    {
      executable: options.codex ?? process.env.CODEX_BIN ?? 'codex',
      args: ['app-server', '--stdio'],
      name: 'Codex app-server',
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      accept: (message) => !('method' in message) && [1, 2].includes(message.id as number),
    },
    handshakeAndRead,
  );
}
