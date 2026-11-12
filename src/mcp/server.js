import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toolDefs, runTool } from '../agent/tools.js';
import { store } from '../store.js';
import { requireAuth } from '../auth.js';
import { exclusive } from '../locks.js';

const MCP_TOOLS = ['get_property_info', 'check_availability', 'get_quote', 'create_hold', 'create_deposit_order', 'pay_deposit_with_token', 'get_booking', 'request_cancellation', 'modify_booking_dates', 'add_experience'];

export function createMcpServer(auth = {}) {
  const server = new McpServer({ name: 'innkeeper-property', version: '0.1.0' }, { instructions: `Booking endpoint for ${store.property?.name || 'the property'}. Check availability, get a quote (you may request a discount; policy decides), create a hold with the guest's name and email, then pay the deposit with a saved PayPal payment token or hand the approve_url to the payer. Prices and refunds come only from these tools.` });
  for (const def of toolDefs.filter((t) => MCP_TOOLS.includes(t.name))) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.schema.shape }, async (args) => {
      const result = await exclusive(() => runTool(def.name, args, { actor: 'mcp_agent', channel: 'mcp', conversation_id: null, principal_id: auth.principal_id, session_id: auth.id, traveler_id: auth.traveler_id || null, can_pay: auth.kind === 'mcp' && auth.can_pay, max_total: auth.max_total }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: Boolean(result?.error) };
    });
  }
  server.registerResource('property-policy', 'innkeeper://policy', { description: 'Booking, payment and cancellation policy in plain language', mimeType: 'text/plain' }, async () => ({ contents: [{ uri: 'innkeeper://policy', mimeType: 'text/plain', text: JSON.stringify(store.policy, null, 2) }] }));
  return server;
}

export function mountMcp(app) {
  app.post('/mcp', requireAuth, async (req, res) => {
    const server = createMcpServer(req.auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
    }
  });
  const reject = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Stateless server: use POST /mcp' }, id: null });
  app.get('/mcp', reject);
  app.delete('/mcp', reject);
}
