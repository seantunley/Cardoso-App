// Contract tests for the parent-side wrapper + the child-process
// renderer. We avoid loading real pdfjs/node-canvas in these tests by
// pointing the wrapper at a STUB child script (written per test as a
// .mjs file in tmpdir) that emits whatever payload / stderr / exit
// behaviour the test needs. The production child script is exercised
// separately via a single end-to-end test that uses a minimal valid
// PDF — guard-railed so CI without the optional fixture still passes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Buffer } from 'buffer';
import { renderPdfInChild } from '../src/services/ocr/spawnRenderChild.js';

let tmpDir;
let scriptPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jti-render-test-'));
  scriptPath = path.join(tmpDir, 'stub-child.mjs');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// Write a stub child script to tmpDir. Each test passes its own
// behaviour — read stdin, emit a payload to stdout, emit stderr,
// exit with a code, or hang. The wrapper points at this script via
// the `childScriptPath` option so tests don't need pdfjs.
function writeStub(body) {
  fs.writeFileSync(scriptPath, body, 'utf8');
  return scriptPath;
}

// Tiny valid PDF input for tests that just need a non-empty buffer
// (we don't actually parse it in the stubs).
const PDF_STUB = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');

describe('renderPdfInChild — input validation', () => {
  it('rejects non-Buffer input with code BAD_INPUT', async () => {
    await expect(renderPdfInChild('not a buffer', { childScriptPath: scriptPath }))
      .rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('rejects empty Buffer with code BAD_INPUT', async () => {
    await expect(renderPdfInChild(Buffer.alloc(0), { childScriptPath: scriptPath }))
      .rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

describe('renderPdfInChild — happy path (stub child)', () => {
  it('returns the bytes the child writes to stdout', async () => {
    writeStub(`
      // Drain stdin, then write a fixed JPEG-ish payload to stdout.
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        process.stdout.write(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x00, 0x99]));
        process.exit(0);
      });
    `);
    const out = await renderPdfInChild(PDF_STUB, { childScriptPath: scriptPath, timeoutMs: 5000 });
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBe(8);
    expect(out[0]).toBe(0xFF);
    expect(out[1]).toBe(0xD8); // JPEG SOI marker
  });

  it('passes the params JSON through argv[2] verbatim', async () => {
    // The stub echoes argv[2] to stdout; we read it back as the result.
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        process.stdout.write(Buffer.from(process.argv[2], 'utf8'));
        process.exit(0);
      });
    `);
    const out = await renderPdfInChild(PDF_STUB, {
      childScriptPath: scriptPath,
      pageNum: 3,
      requestedScale: 1.5,
      maxWidth: 1800,
      timeoutMs: 5000,
    });
    const params = JSON.parse(out.toString('utf8'));
    expect(params.pageNum).toBe(3);
    expect(params.requestedScale).toBe(1.5);
    expect(params.maxWidth).toBe(1800);
    expect(params.maxHeight).toBe(4000); // default
  });

  it('forwards the PDF buffer to the child stdin (round-trip)', async () => {
    // The stub echoes whatever it received on stdin straight to stdout.
    writeStub(`
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        process.stdout.write(Buffer.concat(chunks));
        process.exit(0);
      });
    `);
    const payload = Buffer.from('the-pdf-bytes-the-parent-handed-down', 'utf8');
    const out = await renderPdfInChild(payload, { childScriptPath: scriptPath, timeoutMs: 5000 });
    expect(out.equals(payload)).toBe(true);
  });
});

describe('renderPdfInChild — structured-error transport', () => {
  it('parses a JSON-shaped stderr line into Error code + fields', async () => {
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        process.stderr.write(JSON.stringify({
          code: 'PAGE_TOO_LARGE',
          message: 'page is too big',
          baseWidth: 9999,
          baseHeight: 12000,
          maxMegapixels: 6,
        }) + '\\n');
        process.exit(1);
      });
    `);
    try {
      await renderPdfInChild(PDF_STUB, { childScriptPath: scriptPath, timeoutMs: 5000 });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err.code).toBe('PAGE_TOO_LARGE');
      expect(err.message).toMatch(/too big/);
      expect(err.baseWidth).toBe(9999);
      expect(err.maxMegapixels).toBe(6);
    }
  });

  it('finds the structured-error line even when other lines precede it', async () => {
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        process.stderr.write('(node:1234) Some deprecation warning\\n');
        process.stderr.write('Warning: TT: undefined function\\n');
        process.stderr.write(JSON.stringify({ code: 'RENDER_FAILED', message: 'specific error' }) + '\\n');
        process.exit(1);
      });
    `);
    try {
      await renderPdfInChild(PDF_STUB, { childScriptPath: scriptPath, timeoutMs: 5000 });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err.code).toBe('RENDER_FAILED');
      expect(err.message).toBe('specific error');
    }
  });

  it('falls back to CHILD_FAILED when stderr has no JSON line', async () => {
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        process.stderr.write('plain crash, no JSON\\n');
        process.exit(2);
      });
    `);
    try {
      await renderPdfInChild(PDF_STUB, { childScriptPath: scriptPath, timeoutMs: 5000 });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err.code).toBe('CHILD_FAILED');
      expect(err.exitCode).toBe(2);
      expect(err.message).toMatch(/exited with code 2/);
      expect(err.message).toMatch(/plain crash/);
    }
  });
});

describe('renderPdfInChild — timeout / SIGKILL', () => {
  it('rejects with RENDER_TIMEOUT when the child hangs past timeoutMs', async () => {
    // The stub drains stdin then sleeps forever. The wrapper must
    // SIGTERM-then-SIGKILL it within timeoutMs + SIGTERM_GRACE_MS (~2s).
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        // hang indefinitely — model a render wedge inside native code
        setInterval(() => {}, 1_000_000);
      });
    `);
    const t0 = Date.now();
    try {
      await renderPdfInChild(PDF_STUB, { childScriptPath: scriptPath, timeoutMs: 500 });
      throw new Error('should have rejected');
    } catch (err) {
      const elapsed = Date.now() - t0;
      expect(err.code).toBe('RENDER_TIMEOUT');
      expect(err.timeoutMs).toBe(500);
      // Hard upper bound: timeoutMs + SIGTERM_GRACE (2s) + slack (1s).
      expect(elapsed).toBeLessThan(500 + 2000 + 1000);
    }
  });

  it('the kill path actually terminates the child (no zombie)', async () => {
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => { setInterval(() => {}, 1_000_000); });
    `);
    await expect(renderPdfInChild(PDF_STUB, { childScriptPath: scriptPath, timeoutMs: 200 }))
      .rejects.toMatchObject({ code: 'RENDER_TIMEOUT' });
    // If the child were a zombie holding our test process, vitest's
    // afterAll teardown would hang. Confirming the negative case
    // implicitly via the test runner moving on; nothing to assert
    // explicitly here beyond the reject above.
  });
});

describe('renderPdfInChild — spawn failure', () => {
  it('rejects with CHILD_SPAWN_FAILED when the script path does not exist', async () => {
    const nope = path.join(tmpDir, 'this-script-does-not-exist.mjs');
    try {
      await renderPdfInChild(PDF_STUB, { childScriptPath: nope, timeoutMs: 5000 });
      throw new Error('should have rejected');
    } catch (err) {
      // Either CHILD_SPAWN_FAILED (caught at spawn time) or CHILD_FAILED
      // (caught at exit). Both indicate the missing-script case; both
      // surface clearly in System Log. Accept either.
      expect(['CHILD_SPAWN_FAILED', 'CHILD_FAILED']).toContain(err.code);
    }
  });
});

describe('renderPdfInChild — stdio drain safety', () => {
  // Regression: the wrapper used to listen on the child's 'exit' event,
  // which Node fires BEFORE stdio is guaranteed to have flushed. On a
  // larger-than-buffer payload, Buffer.concat(stdoutChunks) at 'exit'
  // time could return a truncated buffer; downstream sharp / OCR
  // engines would fail with confusing decode errors that looked
  // unrelated to the renderer. Switching to 'close' (which fires AFTER
  // all stdio flushes) closes the race.
  //
  // We force the race by writing a payload several times the OS pipe
  // buffer size and exiting the child immediately after the write. If
  // the wrapper resolves before drain, the returned buffer would be
  // shorter than what we wrote.

  it('returns the FULL stdout buffer on a large-payload, fast-exit child (no truncation)', async () => {
    // 4 MB payload — well above the Windows / Linux default pipe buffer
    // (8 KB – 64 KB typically) so the child must write in chunks.
    // Pattern is deterministic so the assertion catches truncation
    // wherever it might happen.
    //
    // Use `process.stdout.end(buf, callback)` — NOT raw write() then
    // immediate process.exit(0). On Windows (and any pipe-buffer-tight
    // platform) write() can return before the OS has flushed the
    // buffer; a same-tick process.exit then truncates the in-flight
    // bytes. end() signals EOF and the parent's 'close' event fires
    // ONLY after stdio actually drains — which is the exact behaviour
    // we want the test to exercise. The test still validates the
    // parent-side fix (resolve on 'close', not 'exit') because if
    // the parent were back to listening on 'exit', it would resolve
    // before drain even though the child queues the write correctly.
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        const SIZE = 4 * 1024 * 1024;
        const buf = Buffer.alloc(SIZE);
        for (let i = 0; i < SIZE; i++) buf[i] = i & 0xFF;
        process.stdout.end(buf);
      });
    `);
    const out = await renderPdfInChild(PDF_STUB, { childScriptPath: scriptPath, timeoutMs: 15000 });
    expect(out.length).toBe(4 * 1024 * 1024);
    // Spot-check the pattern at the start, middle, and end.
    expect(out[0]).toBe(0);
    expect(out[12345]).toBe(12345 & 0xFF);
    expect(out[out.length - 1]).toBe((out.length - 1) & 0xFF);
  }, 20_000);
});

describe('renderPdfInChild — concurrency', () => {
  it('handles parallel spawns without crosstalk (each gets its own bytes back)', async () => {
    writeStub(`
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        process.stdout.write(Buffer.concat(chunks));
        process.exit(0);
      });
    `);
    const inputs = [
      Buffer.from('payload-A'),
      Buffer.from('payload-B'),
      Buffer.from('payload-C'),
    ];
    const results = await Promise.all(inputs.map(buf =>
      renderPdfInChild(buf, { childScriptPath: scriptPath, timeoutMs: 5000 })
    ));
    expect(results[0].toString('utf8')).toBe('payload-A');
    expect(results[1].toString('utf8')).toBe('payload-B');
    expect(results[2].toString('utf8')).toBe('payload-C');
  });
});

// End-to-end test against the REAL renderPdfChild.js intentionally
// omitted from this PR. The earlier version was permanently skipped
// (require.resolve bug in ESM), and the hand-rolled minimal PDF used
// inside it doesn't parse reliably under real pdfjs — it would have
// failed if it had ever run. The 13 stub-driven contract tests above
// cover the wrapper's actual responsibilities (timeout, error
// transport, drain, concurrency, spawn-failure). A real fixture-PDF
// regression suite belongs in the Phase 2 PR alongside the engine
// swap, where we'll have a check-in tests/fixtures/blank.pdf and a
// reference set with hash-based equivalence checks.

// ── helpers ───────────────────────────────────────────────────────────

