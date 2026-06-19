import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execPath } from 'node:process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const serverPath = resolve(__dirname, 'index.ts');

  const client = new Client(
    { name: 'dpay-mcp-test-client', version: '0.1.0' },
    { capabilities: {} },
  );

  const transport = new StdioClientTransport({
    command: execPath,
    args: ['--import', 'tsx/esm', serverPath],
    env: {
      RPC_URL: process.env.RPC_URL ?? '',
      CHAIN_ID: process.env.CHAIN_ID ?? '',
      PRIVATE_KEY: process.env.PRIVATE_KEY ?? '',
    },
  });

  await client.connect(transport);

  // List tools
  const { tools } = await client.listTools();
  console.log('Available tools:');
  for (const t of tools) {
    console.log(`  ${t.name} — ${t.description?.split('\n')[0]}`);
  }

  // Call ping
  const result = await client.callTool({ name: 'ping', arguments: {} });
  console.log('\nping result:', result.content);

  await client.close();
}

main().catch((err) => {
  console.error('Client error:', err);
  process.exit(1);
});