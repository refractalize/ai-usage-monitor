import { type ChildProcess, type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CollectionError, type JsonObject, object } from './models.ts';
export interface RpcTransport {
  send(message: JsonObject): void;
  receive(): Promise<JsonObject>;
}
class StdioTransport implements RpcTransport {
  private buffer = '';
  private queue: JsonObject[] = [];
  private failure?: CollectionError;
  private waiter?: { resolve: (message: JsonObject) => void; reject: (error: Error) => void };
  constructor(
    private child: ChildProcessByStdio<Writable, Readable, null>,
    private name: string,
    private accept: (message: JsonObject) => boolean,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.failure) return;
      this.buffer += chunk;
      for (;;) {
        const end = this.buffer.indexOf('\n');
        if (end < 0) break;
        if (end > 8 * 1024 * 1024) return this.fail(`${this.name} message exceeded size limit.`);
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return this.fail(`${this.name} returned malformed JSON.`);
        }
        if (!object(message)) return this.fail(`${this.name} returned a non-object message.`);
        // Drop notifications/unrelated responses here to bound memory during event floods.
        if (!this.accept(message)) continue;
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = undefined;
          waiter.resolve(message);
        } else {
          this.queue.push(message);
          if (this.queue.length > 16)
            return this.fail(`${this.name} returned too many pending responses.`);
        }
      }
      if (this.buffer.length > 8 * 1024 * 1024)
        this.fail(`${this.name} message exceeded size limit.`);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      this.fail(
        error.code === 'ENOENT'
          ? `${this.name} executable not found; check its installation and configured path.`
          : `Could not start ${this.name}.`,
      ),
    );
    child.stdout.on('end', () =>
      this.fail(
        `${this.name} closed stdout before replying. Check login status and CLI compatibility.`,
      ),
    );
    child.stdin.on('error', () => this.fail(`${this.name} closed its input unexpectedly.`));
  }
  fail(message: string) {
    this.failure ??= new CollectionError(message);
    this.waiter?.reject(this.failure);
    this.waiter = undefined;
  }
  send(message: JsonObject) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  async receive(): Promise<JsonObject> {
    if (this.failure) throw this.failure;
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}
async function stop(child: ChildProcess) {
  child.stdin?.end();
  if (!child.pid) return;
  const closed = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const wait = () => Promise.race([closed, delay(500)]);
  await wait();
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (exited()) break;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* Already exited. */
    }
    await wait();
  }
  child.stdout?.destroy();
  child.stdin?.destroy();
}

export interface ProcessOptions {
  executable: string;
  args: string[];
  name: string;
  accept: (message: JsonObject) => boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export async function runStdio(
  options: ProcessOptions,
  exchange: (transport: RpcTransport) => Promise<JsonObject>,
) {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new CollectionError('Timeout must be positive.');
  if (options.signal?.aborted) throw new CollectionError('Collection cancelled.');
  const child = spawn(options.executable, options.args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
    cwd: options.cwd,
    env: options.env,
  });
  const transport = new StdioTransport(child, options.name, options.accept);
  const timer = setTimeout(() => transport.fail(`Timed out waiting for ${options.name}.`), timeout);
  const abort = () => transport.fail('Collection cancelled.');
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await exchange(transport);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await stop(child);
  }
}
