import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client = null;
export const anthropic = () => client || (client = new Anthropic({ apiKey: config.ai.anthropicKey, timeout: 30000, maxRetries: 0 }));

export const provider = () => {
  if (['auto', 'anthropic'].includes(config.ai.provider) && config.ai.anthropicKey) return 'anthropic';
  if (['auto', 'openai'].includes(config.ai.provider) && config.ai.openaiKey) return 'openai';
  return 'scripted';
};

export const llmAvailable = () => provider() !== 'scripted';

export const modelLabel = () => (provider() === 'anthropic' ? `anthropic:${config.ai.model}` : provider() === 'openai' ? `${config.ai.openaiLabel}:${config.ai.openaiModel}` : 'scripted');

export async function runToolLoop(opts) {
  try { return await (provider() === 'openai' ? openaiLoop(opts) : anthropicLoop(opts)); }
  catch { throw new Error('AI request could not be completed; check provider configuration and retry'); }
}

export function trimHistory(history, limit = 40) {
  const start = Math.max(0, history.length - limit);
  // Keep complete turns: never start with an orphaned tool result or assistant call.
  const boundary = history.findIndex((m, i) => i >= start && m.role === 'user' && typeof m.content === 'string');
  return boundary < 0 ? history : history.slice(boundary);
}

async function anthropicLoop({ system, messages, tools, execute, maxTurns = config.ai.maxTurns, onEvent = () => {} }) {
  const history = [...messages];
  let finalText = '';
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await anthropic().messages.create({ model: config.ai.model, max_tokens: 1500, system, tools, messages: history });
    history.push({ role: 'assistant', content: response.content });
    const text = response.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (text) { finalText = text; onEvent({ type: 'assistant_text', text }); }
    const calls = response.content.filter((c) => c.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || calls.length === 0) break;
    const results = [];
    for (const call of calls) {
      onEvent({ type: 'tool_call', name: call.name, input: call.input });
      const result = await execute(call.name, call.input);
      onEvent({ type: 'tool_result', name: call.name, result });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
    history.push({ role: 'user', content: results });
  }
  return { text: finalText, history };
}

async function openaiLoop({ system, messages, tools, execute, maxTurns = config.ai.maxTurns, onEvent = () => {} }) {
  const history = [...messages];
  const oaTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  let finalText = '';
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const res = await fetch(`${config.ai.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      signal: AbortSignal.timeout(30000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.openaiKey}` },
      body: JSON.stringify({ model: config.ai.openaiModel, messages: [{ role: 'system', content: system }, ...history], tools: oaTools, tool_choice: 'auto', temperature: 0.2, max_tokens: 1500 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`LLM request failed (${res.status}); check provider configuration`);
    const msg = json.choices?.[0]?.message || {};
    const assistant = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
    history.push(assistant);
    const text = (msg.content || '').trim();
    if (text) { finalText = text; onEvent({ type: 'assistant_text', text }); }
    if (!msg.tool_calls?.length) break;
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
      onEvent({ type: 'tool_call', name: call.function.name, input: args });
      const result = await execute(call.function.name, args);
      onEvent({ type: 'tool_result', name: call.function.name, result });
      history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  return { text: finalText, history };
}
