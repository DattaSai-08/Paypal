import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { assertWritable } from './locks.js';
import { config } from './config.js';

const COLLECTIONS = [
  'rooms', 'extras', 'vendors', 'bookings', 'payments', 'invoices', 'payouts',
  'conversations', 'actions', 'escalations', 'travelers', 'webhook_events', 'disputes', 'sessions', 'operations',
];

const emptyState = () => ({
  property: null,
  policy: null,
  clock: { offset_days: 0 },
  ...Object.fromEntries(COLLECTIONS.map((c) => [c, []])),
});

export class Store {
  constructor(file) {
    this.file = file;
    this.state = emptyState();
    this.depth = 0;
    this.lockFile = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.acquire();
    this.load();
    process.once('exit', () => this.close());
  }

  acquire() {
    const gate = `${this.lockFile}.gate`;
    let gateFd;
    try { gateFd = fs.openSync(gate, 'wx', 0o600); }
    catch { throw new Error('Data lock acquisition is in progress; stale gates require administrator inspection'); }
    try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, host: os.hostname() }));
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { throw new Error('Data lock needs administrator inspection'); }
        if (owner.host !== os.hostname()) throw new Error('Data directory is locked by another host');
        try { process.kill(owner.pid, 0); throw new Error('Data directory is already in use'); }
        catch (e) { if (e.code !== 'ESRCH') throw e; }
        fs.unlinkSync(this.lockFile);
      }
    }
    throw new Error('Unable to acquire data directory lock');
    } finally { fs.closeSync(gateFd); fs.unlinkSync(gate); }
  }

  close() {
    if (this.lockFd === undefined) return;
    fs.closeSync(this.lockFd);
    this.lockFd = undefined;
    fs.unlinkSync(this.lockFile);
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { ...emptyState(), ...parsed };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('Data file could not be loaded; refusing to overwrite it');
    }
  }

  reset() {
    assertWritable();
    this.state = emptyState();
    this.flush();
  }

  save() {
    assertWritable();
    if (!this.depth) this.flush();
  }

  transaction(work) {
    assertWritable();
    if (this.depth) return work();
    const before = structuredClone(this.state);
    this.depth += 1;
    try {
      const result = work();
      if (result?.then) throw new Error('Store transactions must be synchronous');
      this.flush();
      return result;
    } catch (error) { this.state = before; throw error; }
    finally { this.depth -= 1; }
  }

  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }

  all(col) {
    return this.state[col];
  }

  get(col, id) {
    return this.state[col].find((r) => r.id === id) || null;
  }

  find(col, pred) {
    return this.state[col].filter(pred);
  }

  findOne(col, pred) {
    return this.state[col].find(pred) || null;
  }

  insert(col, row) {
    assertWritable();
    const record = { id: row.id || newId(col), created_at: this.now().toISOString(), ...row };
    if (this.get(col, record.id)) throw new Error('Duplicate record');
    this.state[col].push(record);
    this.save();
    return record;
  }

  update(col, id, patch) {
    assertWritable();
    const row = this.get(col, id);
    if (!row) throw new Error(`${col}/${id} not found`);
    const next = typeof patch === 'function' ? patch(row) : { ...row, ...patch };
    next.updated_at = this.now().toISOString();
    const idx = this.state[col].findIndex((r) => r.id === id);
    this.state[col][idx] = next;
    this.save();
    return next;
  }

  remove(col, id) {
    assertWritable();
    this.state[col] = this.state[col].filter((r) => r.id !== id);
    this.save();
  }

  setProperty(property) {
    assertWritable();
    this.state.property = property;
    this.save();
  }

  setPolicy(policy) {
    assertWritable();
    this.state.policy = policy;
    this.save();
  }

  get property() {
    return this.state.property;
  }

  get policy() {
    return this.state.policy;
  }

  now() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + (this.state.clock?.offset_days || 0));
    return d;
  }

  today() {
    return this.now().toISOString().slice(0, 10);
  }

  advanceClock(days) {
    this.state.clock.offset_days = (this.state.clock.offset_days || 0) + Number(days);
    this.save();
    return this.state.clock;
  }

  resetClock() {
    this.state.clock.offset_days = 0;
    this.save();
    return this.state.clock;
  }
}

const PREFIX = {
  rooms: 'room', extras: 'xp', vendors: 'vnd', bookings: 'bk', payments: 'pay', invoices: 'inv',
  payouts: 'po', conversations: 'cv', actions: 'act', escalations: 'esc', travelers: 'tr',
  webhook_events: 'wh', disputes: 'dsp',
};

export function newId(col) {
  return `${PREFIX[col] || 'id'}_${crypto.randomUUID()}`;
}

export const store = new Store(path.resolve(process.cwd(), config.dataFile));
