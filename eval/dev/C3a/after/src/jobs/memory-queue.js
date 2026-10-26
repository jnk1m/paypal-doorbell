// Simple in-process job queue. Jobs run one at a time, in order. The queue lives in memory and is lost when the process exits.
const jobs = [];
let running = false;

export const jobQueue = {
  push(job) {
    jobs.push(job);
    if (!running) drain();
  },
};

async function drain() {
  running = true;
  while (jobs.length) await jobs.shift()();
  running = false;
}
