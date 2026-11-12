const DAY = 86400000;

export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const toUtc = (s) => new Date(`${s}T00:00:00Z`);

export const addDays = (s, n) => new Date(toUtc(s).getTime() + n * DAY).toISOString().slice(0, 10);

export const nightsBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / DAY);

export const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / DAY);

export function eachNight(from, to) {
  const out = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const overlaps = (aFrom, aTo, bFrom, bTo) => aFrom < bTo && bFrom < aTo;

export const money = (n) => Math.round(Number(n) * 100) / 100;

export const fmtMoney = (n, currency = 'USD') => `${currency} ${money(n).toFixed(2)}`;
