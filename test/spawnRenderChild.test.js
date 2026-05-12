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

  it('does NOT include jpegQuality in params when caller omits it (child default applies)', async () => {
    // Regression guard for a Phase-2 bug: the parent used to default
    // jpegQuality to 0.85 and serialise it unconditionally, shadowing
    // the child's bumped 0.95 default. Result was every render came
    // out at the lower quality even though the migration's reasoning
    // about digit-edge bleed assumed 0.95. The fix: don't default in
    // the parent; only include the field in paramsJson when the caller
    // explicitly asked for one. The child's default then wins.
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        process.stdout.write(Buffer.from(process.argv[2], 'utf8'));
        process.exit(0);
      });
    `);
    const out = await renderPdfInChild(PDF_STUB, {
      childScriptPath: scriptPath,
      timeoutMs: 5000,
    });
    const params = JSON.parse(out.toString('utf8'));
    expect(params).not.toHaveProperty('jpegQuality');
  });

  it('passes jpegQuality through unchanged when caller does provide it', async () => {
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        process.stdout.write(Buffer.from(process.argv[2], 'utf8'));
        process.exit(0);
      });
    `);
    const out = await renderPdfInChild(PDF_STUB, {
      childScriptPath: scriptPath,
      jpegQuality: 0.7,
      timeoutMs: 5000,
    });
    const params = JSON.parse(out.toString('utf8'));
    expect(params.jpegQuality).toBe(0.7);
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
    writeStub(`
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {
        const SIZE = 4 * 1024 * 1024;
        const buf = Buffer.alloc(SIZE);
        for (let i = 0; i < SIZE; i++) buf[i] = i & 0xFF;
        // No callback / drain wait — write then exit fast to maximise
        // the chance the parent sees 'exit' before the pipe flushes.
        process.stdout.write(buf);
        process.exit(0);
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

describe('renderPdfInChild — end-to-end with the real child script', () => {
  // Uses the production renderPdfChild.js + a minimal valid PDF.
  // PDFium (@hyzyla/pdfium) and sharp are hard deps after the Phase 2
  // engine swap — both ship pre-built binaries (PDFium is WASM, sharp
  // is libvips), no native build toolchain required, so this test is
  // unconditional. If init fails in CI we want to SEE the failure, not
  // silently skip past it.
  //
  // Earlier rev guarded with a `canRunRealChild` helper that called
  // `require.resolve` from this ESM file — `require` is undefined in
  // ESM, the helper threw a ReferenceError every time, was caught, and
  // the test was masked. Removed entirely; if the renderer ever does
  // need an environment guard, use `await import.meta.resolve(...)` /
  // `createRequire(import.meta.url)` rather than bare `require`.

  // Smallest legal PDF that PDFium will accept. Built by hand from the
  // PDF 1.4 spec: catalog + pages + one empty page. 0x0a separators
  // are critical — both PDFium and pdfjs validate the xref offsets.
  const MINIMAL_PDF = makeMinimalPdf();

  it(
    'renders a minimal valid PDF to a JPEG buffer',
    async () => {
      const out = await renderPdfInChild(MINIMAL_PDF, { timeoutMs: 20_000 });
      expect(Buffer.isBuffer(out)).toBe(true);
      expect(out.length).toBeGreaterThan(64);
      // JPEG SOI marker
      expect(out[0]).toBe(0xFF);
      expect(out[1]).toBe(0xD8);
    },
    25_000,
  );
});

// ── helpers ───────────────────────────────────────────────────────────

function makeMinimalPdf() {
  // Hand-built PDF 1.4 with one empty 612×792 page. Verified parseable
  // by pdfjs 4.8.x in a quick local check; if pdfjs ever tightens its
  // parser we'd swap this for a tests/fixtures/blank.pdf check-in.
  const lines = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <<>> >> endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000108 00000 n ',
    'trailer << /Size 4 /Root 1 0 R >>',
    'startxref',
    '180',
    '%%EOF',
    '',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}
