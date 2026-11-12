import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { store } from '../store.js';
import { exclusive } from '../locks.js';

const context = new AsyncLocalStorage();
export const operationId = () => context.getStore();
const retryable = new Set(['createOrder', 'captureOrder', 'createOrderWithVault', 'refundCapture', 'createPayout']);
export const mutationNames = new Set([...retryable, 'createInvoice', 'createPaymentToken', 'createSetupToken', 'sendInvoice', 'cancelInvoice', 'remindInvoice']);
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

export async function durableOperation(method, args, execute) {
  return exclusive(async () => {
    const fingerprint = digest(JSON.stringify([method, args]));
    const id = `op_${fingerprint}`;
    let operation = store.get('operations', id);
    if (operation?.status === 'SUCCEEDED') return structuredClone(operation.result);
    if (operation && (!retryable.has(method) || Date.now() - Date.parse(operation.started_at) >= 5 * 3600000)) {
      throw new Error('Payment operation requires reconciliation; automatic retry is disabled');
    }
    if (!operation) operation = store.insert('operations', { id, method, request: structuredClone(args), fingerprint, request_id: crypto.randomUUID(), status: 'INTENT', started_at: new Date().toISOString() });
    // The intent and stable request ID reach disk before the provider is called.
    try {
      const result = await context.run(operation.request_id, execute);
      store.update('operations', id, { status: 'SUCCEEDED', result: structuredClone(result ?? null), finished_at: new Date().toISOString() });
      return result;
    } catch (error) {
      store.update('operations', id, { status: 'UNKNOWN', last_attempt_at: new Date().toISOString() });
      throw error;
    }
  });
}
