/**
 * Structured, redacted execution traces.
 *
 * A Trace covers one operation (a scrape, an AI question, a browser session)
 * and records the stages it went through: engine, duration, outcome, reason,
 * queue time, bytes, HTTP status, attempts. Secrets never enter a trace.
 */
import { randomUUID } from 'node:crypto';
import { redactUrl, redactErrorMessage } from './redact.js';

const REDACTED_KEYS = new Set(['text', 'value', 'password', 'cookie', 'cookies', 'headers', 'authorization', 'token', 'secret']);

function redactData(data, redact) {
  if (!data || typeof data !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(data)) {
    if (redact && REDACTED_KEYS.has(key.toLowerCase())) {
      out[key] = '[redacted]';
    } else if (typeof val === 'string') {
      out[key] = redact ? redactErrorMessage(val) : val;
    } else if (val instanceof Error) {
      out[key] = redact ? redactErrorMessage(val.message) : val.message;
    } else {
      out[key] = val;
    }
  }
  return out;
}

class Stage {
  constructor(trace, name, { engine } = {}) {
    this._trace = trace;
    this.record = {
      name,
      engine: engine ?? null,
      startedAt: new Date().toISOString(),
      durationMs: null,
      outcome: null,
      reason: null,
      bytesIn: null,
      bytesOut: null,
      httpStatus: null,
      attempts: null,
      queueMs: null,
      error: null,
    };
    this._startedMs = Date.now();
    this._ended = false;
  }

  end({ outcome = 'ok', reason, bytesIn, bytesOut, httpStatus, attempts, queueMs, error } = {}) {
    if (this._ended) return this.record;
    this._ended = true;
    const r = this.record;
    r.durationMs = Date.now() - this._startedMs;
    r.outcome = outcome;
    if (reason != null) r.reason = String(reason);
    if (bytesIn != null) r.bytesIn = bytesIn;
    if (bytesOut != null) r.bytesOut = bytesOut;
    if (httpStatus != null) r.httpStatus = httpStatus;
    if (attempts != null) r.attempts = attempts;
    if (queueMs != null) r.queueMs = queueMs;
    if (error != null) {
      const msg = error instanceof Error ? error.message : String(error);
      r.error = this._trace.redact ? redactErrorMessage(msg) : msg;
    }
    return r;
  }
}

export class Trace {
  /**
   * @param {{ operation: string, url?: string, redact?: boolean }} opts
   */
  constructor({ operation, url, redact = true } = {}) {
    this.id = randomUUID();
    this.operation = operation || 'operation';
    this.redact = redact;
    this.url = url ? (redact ? redactUrl(url) : url) : null;
    this.startedAt = new Date().toISOString();
    this._startedMs = Date.now();
    this._stages = [];
    this._events = [];
    this._usage = null;
    this._finished = null;
  }

  stage(name, opts = {}) {
    const s = new Stage(this, name, opts);
    this._stages.push(s);
    return s;
  }

  event(type, data = {}) {
    this._events.push({ type, at: Date.now(), ...redactData(data, this.redact) });
  }

  setUsage({ provider, model, inputTokens, outputTokens } = {}) {
    this._usage = { provider: provider ?? null, model: model ?? null, inputTokens: inputTokens ?? null, outputTokens: outputTokens ?? null };
  }

  _inferOutcome() {
    const outcomes = this._stages.map(s => s.record.outcome);
    if (outcomes.includes('cancelled')) return 'cancelled';
    if (outcomes.includes('fallback')) return 'fallback';
    if (outcomes.length && outcomes.every(o => o === 'error' || o === 'skipped')) return 'error';
    return 'ok';
  }

  /**
   * @param {{ outcome?: 'ok'|'error'|'cancelled'|'fallback', error?: Error|string }} [opts]
   */
  finish({ outcome, error } = {}) {
    if (this._finished) return this._finished;
    for (const s of this._stages) {
      if (!s._ended) s.end({ outcome: outcome === 'ok' ? 'ok' : (outcome || 'error'), reason: 'unfinished' });
    }
    const record = {
      id: this.id,
      operation: this.operation,
      url: this.url,
      startedAt: this.startedAt,
      durationMs: Date.now() - this._startedMs,
      outcome: outcome || this._inferOutcome(),
      stages: this._stages.map(s => ({ ...s.record })),
      events: this._events.map(e => ({ ...e })),
    };
    if (error != null) {
      const msg = error instanceof Error ? error.message : String(error);
      record.error = this.redact ? redactErrorMessage(msg) : msg;
    }
    if (this._usage) record.usage = { ...this._usage };
    this._finished = record;
    return record;
  }

  toJSON() {
    return this._finished ? { ...this._finished } : this.finish();
  }
}

export default Trace;
