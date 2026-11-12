import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] || process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';
const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const client = new Client({ name: 'innkeeper-cli-agent', version: '0.1.0' });
if (!process.env.MCP_ACCESS_TOKEN) throw new Error('Set MCP_ACCESS_TOKEN to a short-lived token issued by /api/mcp-token');
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_ACCESS_TOKEN}` } } }));
const { tools } = await client.listTools();
console.log(`Connected to ${url}. Tools: ${tools.map((t) => t.name).join(', ')}`);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const parsed = JSON.parse(res.content[0].text);
  console.log(`\n> ${name}(${JSON.stringify(args)})\n${JSON.stringify(parsed, null, 1).slice(0, 1200)}`);
  return parsed;
};

await call('get_property_info', {});
const avail = await call('check_availability', { check_in: plus(21), check_out: plus(24), guests: 2 });
const room = avail.rooms.find((r) => r.available_units > 0 && r.fits_party);
if (room) await call('get_quote', { room_id: room.room_id, check_in: plus(21), check_out: plus(24), guests: 2, requested_discount_pct: 10 });
await client.close();
