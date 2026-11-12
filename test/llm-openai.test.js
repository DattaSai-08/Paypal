import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const LLM_PORT = 4600 + Math.floor(Math.random() * 300);
const PORT = 5000 + Math.floor(Math.random() * 300);
process.env.PORT = String(PORT);
process.env.BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'innkeeper-llm-')), 'db.json');
process.env.PAYPAL_MODE = 'mock';
process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${LLM_PORT}/v1`;
process.env.OPENAI_MODEL = 'fake-model';
process.env.OPENAI_LABEL = 'openai-compatible';

const seen = [];
const fakeLlm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    seen.push(payload);
    const last = payload.messages[payload.messages.length - 1];
    const toolNames = payload.tools.map((t) => t.function.name);
    let message;
    if (last.role === 'user' && /free/.test(last.content) && toolNames.includes('check_availability')) {
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'check_availability', arguments: JSON.stringify({ check_in: '2027-02-10', check_out: '2027-02-12', guests: 2 }) } }] };
    } else if (last.role === 'tool') {
      const result = JSON.parse(last.content);
      const free = (result.rooms || []).filter((r) => r.available_units > 0).map((r) => r.name).join(', ');
      message = { role: 'assistant', content: `Free rooms: ${free}. Which one?` };
    } else {
      message = { role: 'assistant', content: 'Tell me your dates.' };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'cmpl', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
});

const { createApp } = await import('../src/server.js');
const { provider } = await import('../src/agent/llm.js');

let server;
test.before(async () => {
  await new Promise((r) => fakeLlm.listen(LLM_PORT, r));
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
});
test.after(() => { server.close(); fakeLlm.close(); });

test('guest agent runs the tool loop through an OpenAI-compatible endpoint', async () => {
  assert.equal(provider(), 'openai');
  const session = await fetch(`${process.env.BASE_URL}/api/session`, { method: 'POST', headers: { 'x-session-bootstrap': '1' } });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const csrf = (await session.json()).csrf;
  const r = await fetch(`${process.env.BASE_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ message: 'What is free in February?' }) });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.match(j.reply, /Free rooms: .*Estate View Room/);
  assert.equal(j.provider, 'openai-compatible:fake-model');
  assert.equal(seen.length, 2, 'one call to decide the tool, one to answer');
  assert.equal(seen[0].messages[0].role, 'system');
  assert.ok(seen[0].tools.every((t) => t.type === 'function' && t.function.parameters.type === 'object'));
  assert.equal(seen[1].messages.at(-1).role, 'tool');
  assert.equal(seen[1].messages.at(-2).tool_calls[0].id, 'call_1');
});
