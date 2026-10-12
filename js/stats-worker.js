/* ============================================================
   Session-stats worker.

   Counting a session's messages means parsing the whole file, and the biggest
   transcript here is 116 MB — ~480 ms of pure CPU.  Run on the main thread that
   stalls every HTTP request for the duration.  This worker does it on a second
   thread instead, so the server keeps answering while the sidebar fills in.

   It reuses js/parser.js *verbatim* (that module already exports itself for
   Node), so the numbers can never drift from what the frontend computes from
   the same file.  That is the whole reason this isn't a hand-rolled line
   counter.

   Two job kinds:
     { kind: "file", file, mtime, size }
        a plain .jsonl (claude sessions, and dsh sidecars once built)
     { kind: "dsh", id, src, sidecar, fromOffset, mtime, size, key }
        decompress the session's NEW zstd frames into `sidecar`, then count the
        sidecar.  Doing the decompress here keeps the multi-second frame walk
        off the request thread; fromOffset comes from the caller so a session
        that has merely grown only pays for its new frames.

   Output: { batch: [...] } for files, { dshBatch: [...] } for dsh, then { done }.
   ============================================================ */
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const { parse } = require("./parser.js");

let dsh = null;
try { dsh = require("./dsh.js"); } catch (e) { dsh = null; }

// Ship results in batches rather than one giant postMessage: the main thread
// persists each batch immediately, so a crash mid-way still keeps the work done
// so far instead of losing the whole pass.
const BATCH = 8;

const files = (workerData && workerData.files) || [];
const dshJobs = (workerData && workerData.dshJobs) || [];

let batch = [];
const flush = () => {
  if (!batch.length) return;
  parentPort.postMessage({ batch });
  batch = [];
};

for (const item of files) {
  let stats = null;
  try {
    stats = parse(fs.readFileSync(item.file, "utf8"), item.file).stats;
  } catch (e) {
    // Unreadable/deleted mid-pass. Report a null stats so the main thread
    // records the attempt against this mtime+size instead of re-queuing it on
    // every poll — a file that can't be read shouldn't spin the worker forever.
    stats = null;
  }
  batch.push({ file: item.file, mtime: item.mtime, size: item.size, stats });
  if (batch.length >= BATCH) flush();
}
flush();

/* dsh: extend each sidecar, then count it. One at a time — the biggest session
   is 33k frames and 57 MB of decoded text, so holding two at once is wasteful. */
for (const job of dshJobs) {
  const out = { key: job.key, mtime: job.mtime, size: job.size, stats: null, srcOffset: job.fromOffset, outLength: null };
  try {
    if (dsh) {
      let buf = fs.readFileSync(job.src);
      const from = Math.min(job.fromOffset || 0, buf.length);
      // fromOffset 0 with an existing sidecar means our record of how far we had
      // consumed was lost (index reset, cache wiped). Appending from 0 would
      // duplicate everything, so rebuild: truncate and start over.
      if (!from) { try { fs.rmSync(job.sidecar, { force: true }); } catch (e) {} }
      if (from < buf.length) {
        const { text, consumed } = dsh.decodeFrom(buf, from);
        const converted = dsh.convertText(text, job.id);
        fs.mkdirSync(path.dirname(job.sidecar), { recursive: true });
        // Always append, even when nothing converted: appendFileSync creates the
        // file, and a header-only session (no user/assistant rows at all) should
        // read as "0 条" rather than fail to parse and sit blank forever.
        fs.appendFileSync(job.sidecar, converted, "utf8");
        out.srcOffset = consumed;
        buf = null;
      }
      out.outLength = fs.existsSync(job.sidecar) ? fs.statSync(job.sidecar).size : 0;
      out.stats = parse(fs.readFileSync(job.sidecar, "utf8"), job.id).stats;
    }
  } catch (e) {
    out.stats = null;   // leave the offsets as they were; next pass retries
  }
  parentPort.postMessage({ dshBatch: [out] });
}

parentPort.postMessage({ done: true });
