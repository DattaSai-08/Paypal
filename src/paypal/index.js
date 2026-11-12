import { isMockPayPal } from '../config.js';
import { live } from './live.js';
import { mock } from './mock.js';
import { durableOperation, mutationNames } from './operations.js';

const backend = isMockPayPal() ? mock : live;
export const paypal = new Proxy(backend, {
  get(target, name) {
    if (typeof target[name] !== 'function') return target[name];
    return (...args) => mutationNames.has(name)
      ? durableOperation(name, args, () => target[name](...args))
      : target[name](...args);
  },
});

export const paypalMode = () => (isMockPayPal() ? 'mock' : live.mode);

export const captureFromOrder = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0] || null;

export const approveLink = (resource) => resource?.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href || null;
