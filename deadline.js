/**
 * Deadline — one total operation budget shared by every stage.
 *
 * Wraps an AbortController. The signal aborts when the budget elapses or
 * when a parent signal aborts, so it can be handed to fetch(), child
 * processes, Puppeteer waits and the browser pool alike.
 */

export class DeadlineError extends Error {
  /** @param {'DEADLINE_EXCEEDED'|'ABORTED'} code */
  constructor(code, message) {
    super(message || (code === 'ABORTED' ? 'operation aborted' : 'deadline exceeded'));
    this.name = 'DeadlineError';
    this.code = code;
  }
}

export class Deadline {
  /**
   * @param {{ totalMs?: number, signal?: AbortSignal }} [opts]
   */
  constructor({ totalMs, signal } = {}) {
    this._controller = new AbortController();
    this._reason = null;
    this._timer = null;
    this._parent = signal || null;
    this._onParentAbort = null;

    const bounded = Number.isFinite(totalMs) && totalMs >= 0;
    this._deadlineAt = bounded ? Date.now() + totalMs : Infinity;

    if (bounded) {
      this._timer = setTimeout(() => this._abort('timeout'), totalMs);
      if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    if (signal) {
      if (signal.aborted) {
        this._abort('aborted');
      } else {
        this._onParentAbort = () => this._abort('aborted');
        signal.addEventListener('abort', this._onParentAbort, { once: true });
      }
    }
  }

  /**
   * Accepts a Deadline, a number of ms, an options object or undefined.
   * @returns {Deadline}
   */
  static from(input) {
    if (input instanceof Deadline) return input;
    if (typeof input === 'number') return new Deadline({ totalMs: input });
    if (input && typeof input === 'object') return new Deadline(input);
    return new Deadline();
  }

  get signal() {
    return this._controller.signal;
  }

  remaining() {
    if (this._reason) return 0;
    if (this._deadlineAt === Infinity) return Infinity;
    return Math.max(0, this._deadlineAt - Date.now());
  }

  expired() {
    if (this._reason) return true;
    if (this._deadlineAt !== Infinity && Date.now() >= this._deadlineAt) {
      this._abort('timeout');
      return true;
    }
    return false;
  }

  /** @returns {'timeout'|'aborted'|null} */
  reason() {
    this.expired();
    return this._reason;
  }

  /** Timeout to give a single stage: never more than what is left. */
  stageTimeout(maxMs) {
    const rem = this.remaining();
    if (rem === Infinity) return maxMs;
    return Math.max(0, Math.min(maxMs, rem));
  }

  throwIfExpired() {
    if (this.expired()) {
      throw new DeadlineError(this._reason === 'aborted' ? 'ABORTED' : 'DEADLINE_EXCEEDED');
    }
  }

  /** A sub-deadline bounded by min(maxMs, remaining) that also follows this signal. */
  child(maxMs) {
    const rem = this.remaining();
    const totalMs = rem === Infinity ? maxMs : Math.min(maxMs, rem);
    return new Deadline({ totalMs, signal: this.signal });
  }

  dispose() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._parent && this._onParentAbort) {
      this._parent.removeEventListener('abort', this._onParentAbort);
      this._onParentAbort = null;
    }
  }

  _abort(reason) {
    if (this._reason) return;
    this._reason = reason;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const err = new DeadlineError(reason === 'aborted' ? 'ABORTED' : 'DEADLINE_EXCEEDED');
    this._controller.abort(err);
  }
}

export default Deadline;
