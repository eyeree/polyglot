// Worker pool wrapper around solver-worker.js.
export class SolverPool {
  constructor(sizeFn) {
    this.sizeFn = sizeFn;
    this.workers = [];     // {w, job}
    this.queue = [];
    this.nextId = 1;
  }

  /** run({seed, moves, opts}, onProgress) -> {promise, cancel} */
  run(payload, onProgress) {
    const job = { id: this.nextId++, payload, onProgress, worker: null, cancelled: false };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.queue.push(job);
    this._pump();
    return {
      promise: job.promise,
      cancel: () => {
        job.cancelled = true;
        if (job.worker) { job.worker.w.terminate(); this.workers = this.workers.filter(x => x !== job.worker); job.resolve({ result: 'cancelled', path: [], explored: 0 }); this._pump(); }
        else { this.queue = this.queue.filter(j => j !== job); job.resolve({ result: 'cancelled', path: [], explored: 0 }); }
      },
    };
  }

  get busy() { return this.workers.filter(x => x.job).length + this.queue.length; }

  _pump() {
    const size = Math.max(1, Math.min(8, Number(this.sizeFn()) || 1));
    while (this.queue.length) {
      let slot = this.workers.find(x => !x.job);
      if (!slot) {
        if (this.workers.length >= size) return;
        const w = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
        slot = { w, job: null };
        w.onmessage = (e) => this._onMessage(slot, e.data);
        w.onerror = (e) => { if (slot.job) { slot.job.reject(e); slot.job = null; } this._pump(); };
        this.workers.push(slot);
      }
      const job = this.queue.shift();
      if (job.cancelled) continue;
      slot.job = job; job.worker = slot;
      slot.w.postMessage({ id: job.id, ...job.payload });
    }
  }

  _onMessage(slot, msg) {
    const job = slot.job;
    if (!job || msg.id !== job.id) return;
    if (msg.progress != null && !msg.done) { job.onProgress?.(msg.progress); return; }
    if (msg.done) { slot.job = null; job.worker = null; job.resolve(msg); this._pump(); }
  }
}
