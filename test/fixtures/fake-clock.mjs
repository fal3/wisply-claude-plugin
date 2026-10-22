// Timers and a clock the tests move by hand. setTimeout returns a number, so
// the code's optional unref() is a no-op here.
export function createFakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  const flush = async () => {
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => { setImmediate(resolve); });
  };
  return {
    now: () => now,
    timers: {
      setTimeout(callback, ms) {
        const id = nextId;
        nextId += 1;
        timers.set(id, { callback, at: now + Math.max(0, ms) });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    },
    /** Delays of the scheduled timers, from now. */
    pending: () => [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
    flush,
    /** Moves the clock, running each timer that comes due, in order. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}
