/**
 * Evidence client — lightweight RPC bridge to the Helia worker thread.
 *
 * The MCP server imports this module.  It spawns a Worker that runs Helia
 * in a separate thread so heavy IPFS startup never blocks MCP requests.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { logger as baseLogger } from './logger.js';

const logger = baseLogger.child({ component: 'evidence-client' });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PublishedEvidence {
  uri: string;
  cid: string;
  selfHash: string;
}

// ─── Worker message types ────────────────────────────────────────────────────

type WorkerIncomingMessage =
  | { type: 'log'; level?: 'debug' | 'info' | 'warn' | 'error'; msg: string }
  | { type: 'error'; id?: string; error: string }
  | { type: 'publish-done'; id: string; uri: string; cid: string; selfHash: string }
  | { type: 'ready' }
  | { type: 'init-error'; error: string };

// ─── Worker lifecycle ───────────────────────────────────────────────────────
// IMPORTANT: The worker MUST be compiled to JS first (npm run build).
// tsx cannot reliably serve as a Worker execArgv loader for the Helia tree.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const jsPath = join(__dirname, 'evidence-worker.js');
const tsPath = join(__dirname, 'evidence-worker.ts');

let workerPath: string;
let workerExecArgv: string[] | undefined;

if (existsSync(jsPath)) {
  workerPath = jsPath;
} else if (existsSync(tsPath)) {
  workerPath = tsPath;
  workerExecArgv = ['--import', 'tsx/esm'];
} else {
  throw new Error(
    `evidence-worker not found at ${jsPath} or ${tsPath}. ` +
    'Run `npm run build` first or use tsx for development.',
  );
}

const worker = new Worker(workerPath, { execArgv: workerExecArgv });

// ─── READY gate ────────────────────────────────────────────────────────────
// publishEvidence waits on this promise so we never send a request before the
// worker has finished initializing Helia.

let readyResolve: (() => void) | null = null;
let readyReject: ((err: Error) => void) | null = null;
let readyPromise: Promise<void> | null = null;
let isReady = false;

function getReadyPromise(): Promise<void> {
  if (!readyPromise) {
    readyPromise = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    // Prevent unhandled rejection crashes if init fails before publish is called
    readyPromise.catch(() => {});
  }
  return readyPromise;
}

function rejectReady(err: Error): void {
  readyReject?.(err);
  readyPromise = null; // Clear so the next attempt gets a fresh promise
  readyResolve = null;
  readyReject = null;
}

// ─── Pending request tracking ───────────────────────────────────────────────

type PendingEntry = {
  resolve: (value: PublishedEvidence) => void;
  reject: (reason: Error) => void;
};

const pending = new Map<string, PendingEntry>();

worker.on('message', (raw: unknown) => {
  const msg = raw as WorkerIncomingMessage;

  // Log messages from worker go to stderr
  if (msg.type === 'log') {
    const logContext = { workerMessage: msg.msg };
    switch (msg.level) {
      case 'debug':
        logger.debug(logContext, 'Evidence publisher worker log');
        break;
      case 'warn':
        logger.warn(logContext, 'Evidence publisher worker log');
        break;
      case 'error':
        logger.error(logContext, 'Evidence publisher worker log');
        break;
      default:
        logger.info(logContext, 'Evidence publisher worker log');
    }
    return;
  }

  if (msg.type === 'error') {
    const id = msg.id;
    if (id) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        entry.reject(new Error(msg.error));
      } else {
        logger.error({ requestId: id, errorMessage: msg.error }, 'Evidence publisher returned error for unknown request');
      }
    } else {
      logger.error({ errorMessage: msg.error }, 'Evidence publisher returned error');
    }
    return;
  }

  if (msg.type === 'publish-done') {
    const id = msg.id;
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.resolve({
        uri: msg.uri,
        cid: msg.cid,
        selfHash: msg.selfHash,
      });
    }
    return;
  }

  if (msg.type === 'ready') {
    logger.info('Evidence publisher worker ready');
    isReady = true;
    readyResolve?.();
    return;
  }

  if (msg.type === 'init-error') {
    logger.error({ errorMessage: msg.error }, 'Evidence publisher worker initialization failed');
    // Worker is still alive — reset the gate so a new warmUp/init cycle can retry.
    isReady = false;
    rejectReady(new Error(`Worker init failed: ${msg.error}`));
    return;
  }
});

worker.on('error', (err: unknown) => {
  logger.error({ err }, 'Evidence publisher worker error');
});

worker.on('exit', (code) => {
  logger.warn({ exitCode: code }, 'Evidence publisher worker exited');
  isReady = false;
  rejectReady(new Error(`Worker exited with code ${code}`));
  // Reject all pending requests
  for (const [id, entry] of pending) {
    pending.delete(id);
    entry.reject(new Error(`Worker exited with code ${code}`));
  }
});

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start warming the worker in the background.
 * Fire-and-forget — does not block.  publishEvidence will await readiness internally.
 */
export function warmUp(): void {
  // Prevent overwriting an active or already-completed startup
  if (isReady || readyPromise) return;

  void getReadyPromise(); // Ensure promise exists before sending init
  worker.postMessage({ type: 'init' });
}

/**
 * Publish an evidence document via the Helia worker.
 * If the worker isn't ready yet, returns immediately with a message telling
 * the LLM to retry — rather than blocking for 180s waiting for Helia init.
 */
export async function publishEvidence(title: string, description: string): Promise<PublishedEvidence> {
  if (!isReady) {
    throw new Error(
      'Evidence publisher is still initializing. Please call submit_evidence again in a few seconds.',
    );
  }
  const id = randomUUID();
  return new Promise<PublishedEvidence>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'publish', id, title, description });
  });
}

/**
 * Gracefully shut down the worker.
 * Resolves on worker exit, with a forceful terminate timeout as a safety net.
 */
export async function closeWorker(): Promise<void> {
  return new Promise<void>((resolve) => {
    // Listen for the exit event as the definitive signal
    worker.once('exit', () => resolve());
    worker.postMessage({ type: 'close' });

    // Forceful fallback: terminate if the worker doesn't exit within 5 seconds
    setTimeout(() => {
      void worker.terminate();
      resolve();
    }, 5000);
  });
}
