/**
 * Demo WebSocket Server
 *
 * Express server that:
 *   - Serves the static UI from the `ui/` directory
 *   - Runs a WebSocket server that broadcasts demo events to all connected browsers
 *
 * Can be started standalone:
 *   npx tsx src/demo/demo-server.ts
 *
 * Or imported and started from another module (e.g. the agent demo):
 *   import { startDemoServer } from './demo-server.js';
 *   startDemoServer();
 */

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { demoEvents } from './demo-events.js';

// ─── Paths ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, '..', '..', 'ui');

// ─── Server state ───────────────────────────────────────────────────────────

let serverStarted = false;

export function startDemoServer(port: number = 3000): void {
  if (serverStarted) return;
  serverStarted = true;

  const app = express();
  app.use(express.static(uiDir));

  const server = createServer(app);

  const wss = new WebSocketServer({ server });

  function broadcast(data: unknown) {
    const payload = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  demoEvents.on('event', (event) => {
    broadcast(event);
  });

  server.listen(port, () => {
    console.log(`\n  🎛️  Demo UI server running at http://localhost:${port}`);
    console.log(`  📡 WebSocket broadcasting live events\n`);
  });
}

// ─── Standalone entry point ─────────────────────────────────────────────────

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const PORT = parseInt(process.env.DEMO_PORT ?? '3000', 10);
  startDemoServer(PORT);
}
