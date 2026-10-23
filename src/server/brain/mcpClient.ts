// The brain talks to DocSaathi exactly like Alexa+ would: as an MCP client over Streamable HTTP.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { accessTokenFor } from '../alexaLink.js';
import { config } from '../config.js';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

const clients = new Map<string, Promise<Client>>();

/**
 * One MCP client per family. Like Alexa+, it sends the family's OAuth access token (from account
 * linking, see alexaLink.ts) with every request, refreshes it on a 401, and fails with
 * LinkRequiredError when the family has not linked DocSaathi.
 */
function clientFor(householdId: string): Promise<Client> {
  let c = clients.get(householdId);
  if (!c) {
    c = (async () => {
      // Default version negotiation = the 2025-11-25 handshake, which is what Alexa+ speaks today.
      const client = new Client({ name: 'docsaathi-alexa-simulator', version: '0.1.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${config.baseUrl}/mcp`), {
          authProvider: {
            token: () => accessTokenFor(householdId),
            onUnauthorized: async () => {
              await accessTokenFor(householdId, true);
            },
          },
        }),
      );
      return client;
    })();
    c.catch(() => clients.delete(householdId));
    clients.set(householdId, c);
  }
  return c;
}

export async function callTool(householdId: string, name: string, args: Record<string, unknown>): Promise<ToolCall> {
  const client = await clientFor(householdId);
  const result = (await client.callTool({ name, arguments: args })) as ToolCall['result'];
  return { name, arguments: args, result };
}

export async function listTools(householdId: string) {
  return (await clientFor(householdId)).listTools();
}

export function speechOf(call: ToolCall): string {
  return call.result.content?.find((c) => c.type === 'text')?.text ?? '';
}

export function kindOf(call: ToolCall): string {
  return String(call.result.structuredContent?.kind ?? 'unknown');
}
