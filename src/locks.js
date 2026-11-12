import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
let tail = Promise.resolve();
let active = null;
export async function exclusive(work) {
  if (active && context.getStore() === active) return work();
  const previous = tail;
  let release;
  tail = new Promise((resolve) => { release = resolve; });
  await previous;
  const token = {};
  active = token;
  try { return await context.run(token, work); }
  finally { active = null; release(); }
}

export function assertWritable() {
  if (active && context.getStore() !== active) throw new Error('Another operation is in progress; retry shortly');
}
