/**
 * Evidence worker — runs Helia in a dedicated thread.
 *
 * Communicates with the MCP server process via worker_threads message passing.
 * Helia startup never blocks the MCP event loop.
 */

import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('evidence-worker must be launched as a Worker thread');
}

// ─── Catch background errors from Helia/libp2p ──────────────────────────────

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`Unhandled rejection in background task: ${msg}`);
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
  process.exit(1);
});

// ─── Lazy Helia init ────────────────────────────────────────────────────────

let publisher: Awaited<ReturnType<typeof createInstance>> | undefined;
let readyPromise: Promise<void> | null = null;

function log(msg: string): void {
  parentPort!.postMessage({ type: 'log', msg });
}

async function createInstance() {
  const { createEvidencePublisher } = await import('@rakelabs/evidence-publisher');

  const endpoint = process.env['EVIDENCE_IPFS_ENDPOINT'];
  if (endpoint) {
    const authType = process.env['EVIDENCE_IPFS_AUTH_TYPE'] ?? 'bearer';
    const authToken = process.env['EVIDENCE_IPFS_AUTH_TOKEN'] ?? '';
    const gatewayUrls = process.env['EVIDENCE_IPFS_GATEWAYS']
      ? process.env['EVIDENCE_IPFS_GATEWAYS'].split(',').map(s => s.trim())
      : undefined;

    const auth = authType === 'bearer'
      ? { type: 'bearer' as const, token: authToken }
      : authType === 'basic'
        ? { type: 'basic' as const, username: process.env['EVIDENCE_IPFS_USERNAME'] ?? '', password: process.env['EVIDENCE_IPFS_PASSWORD'] ?? '' }
        : { type: 'none' as const };

    const headers: Record<string, string> | undefined = process.env['EVIDENCE_IPFS_HEADERS']
      ? JSON.parse(process.env['EVIDENCE_IPFS_HEADERS']) as Record<string, string>
      : undefined;

    const fields: Record<string, string> | undefined = process.env['EVIDENCE_IPFS_UPLOAD_FIELDS']
      ? JSON.parse(process.env['EVIDENCE_IPFS_UPLOAD_FIELDS']) as Record<string, string>
      : undefined;

    const fileFieldName = process.env['EVIDENCE_IPFS_FILE_FIELD'];

    return createEvidencePublisher({
      config: {
        addressing: 'content',
        provider: {
          name: endpoint,
          url: endpoint,
          auth,
          ...(headers ? { headers } : {}),
          ...(fields ? { fields } : {}),
          ...(fileFieldName ? { fileFieldName } : {}),
        },
        pinning: { enabled: true },
      },
      gatewayBaseUrls: gatewayUrls,
    });
  }

  // Default: in-process Helia
  log('no EVIDENCE_IPFS_ENDPOINT set, starting in-process Helia');
  return createEvidencePublisher({
    config: {
      addressing: 'content',
      provider: { name: 'in-process-helia', auth: { type: 'none' } },
      pinning: { enabled: true },
    },
  });
}

function withTimeout<T>(p: Promise<T>, ms = 180_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Helia init timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

async function ensureReady(): Promise<void> {
  if (publisher) return;
  if (readyPromise) return readyPromise;

  const t0 = Date.now();
  log('initializing...');

  readyPromise = (async () => {
    try {
      publisher = await withTimeout(createInstance());
      log(`ready in ${Date.now() - t0}ms`);
    } catch (err) {
      publisher = undefined;
      throw err;
    } finally {
      readyPromise = null;
    }
  })();

  return readyPromise;
}


// ─── Message handler ────────────────────────────────────────────────────────
// NOTE: Initialization is driven by the MCP client (warmUp), NOT by the worker.
// This ensures a single authority over lifecycle and avoids races.

let initStarted = false;

type WorkerIncomingMessage =
  | { type: 'init' }
  | { type: 'publish'; id: string; title: string; description: string }
  | { type: 'close' };

parentPort.on('message', (raw: unknown) => {
  const msg = raw as WorkerIncomingMessage;
  const id = raw !== null && typeof raw === 'object' && 'id' in raw ? String((raw as Record<string, unknown>).id) : undefined;

  // Handle unknown message types at top level so we can extract the id
  if (typeof msg === 'object' && msg !== null && 'type' in msg &&
      !['init', 'publish', 'close'].includes((msg as Record<string, unknown>).type as string)) {
    parentPort!.postMessage({ type: 'error', id, error: `Unknown message type` });
    return;
  }

  handleMessage(msg).catch((err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ type: 'error', id, error: errorMsg });
  });
});

async function handleMessage(msg: WorkerIncomingMessage): Promise<void> {
  switch (msg.type) {
    case 'init': {
      if (initStarted) break;
      initStarted = true;
      try {
        await ensureReady();
        // ready means "Helia is initialized and publish is safe"
        parentPort!.postMessage({ type: 'ready' });
      } catch (err) {
        initStarted = false;
        const errorMsg = err instanceof Error ? err.message : String(err);
        parentPort!.postMessage({ type: 'init-error', error: errorMsg });
      }
      break;
    }

    case 'publish': {
      await ensureReady();
      if (!publisher) {
        throw new Error('Publisher not initialized after ensureReady');
      }
      const result = await publisher.publish({
        title: msg.title,
        description: msg.description,
      });
      parentPort!.postMessage({
        type: 'publish-done',
        id: msg.id,
        uri: result.document.uri,
        cid: result.document.cid,
        selfHash: result.selfHash,
      });
      break;
    }

    case 'close': {
      try {
        if (publisher) {
          await publisher.close();
        }
      } catch (closeErr) {
        const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        log(`Warning: Helia failed to close cleanly: ${closeMsg}`);
      } finally {
        // Always exit the process, even if closing the datastore failed
        parentPort!.postMessage({ type: 'closed' });
        process.exit(0);
      }
      break; // Technically unreachable, but good practice
    }

    default: {
      parentPort!.postMessage({
        type: 'error',
        error: 'Unknown message type',
      });
    }
  }
}
