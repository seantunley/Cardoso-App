import React, { useState, useRef } from 'react';
import { FileSpreadsheet, Loader2, AlertTriangle, X, CheckCircle2 } from 'lucide-react';
import { isoYear } from '@/lib/isoWeek';

export default function FileUpload({ onComplete }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  // Soft warning for files that were filtered out client-side before
  // the upload even started (e.g. a stray .pdf in a drag-multi). Lives
  // in its own state so the upload handlers' setError('') reset can't
  // wipe it before the user has a chance to read it. Persists until
  // the next drop replaces it.
  const [skippedNotice, setSkippedNotice] = useState('');
  // Structured rejection — set when the SINGLE-file path returns a 400
  // with a `reasons` array. Each reason renders as its own bullet so
  // the operator can fix them all before retrying.
  const [rejection, setRejection] = useState(null); // { fileName, reasons: string[] }
  // Batch results modal — set after a multi-file upload returns. Each
  // entry is one file's outcome (success | rejected | error).
  const [batchResults, setBatchResults] = useState(null); // [{ filename, status, ... }]
  const fileRef = useRef();

  // Sniff the file list. Anything not .xlsx/.xls is dropped here so
  // the server's multer fileFilter can't reject the whole batch on
  // one stray PDF.
  const filterAccepted = (fileList) => {
    return Array.from(fileList).filter((f) => {
      const ext = f.name.split('.').pop().toLowerCase();
      return ['xlsx', 'xls'].includes(ext);
    });
  };

  const handleSingle = async (file) => {
    setError('');
    setRejection(null);
    setBatchResults(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      // ISO year (not calendar year) — on Dec 29-31 of years where Jan 1
      // is Mon/Tue/Wed, the calendar year is the OLD year but the recon
      // is logically for the NEW ISO year's W1. Without this, a late-Dec
      // upload could be filed under the wrong year.
      form.append('year', String(isoYear(new Date())));
      const r = await fetch('/api/bat/upload', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const data = await r.json();
      if (!r.ok) {
        if (Array.isArray(data.reasons) && data.reasons.length > 0) {
          setRejection({ fileName: data.fileName || file.name, reasons: data.reasons });
          if (fileRef.current) fileRef.current.value = '';
          return;
        }
        throw new Error(data.error || 'Upload failed');
      }
      onComplete(data.reconciliation, data.backfilled || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  // Mirror of the server's `upload.array('files', BATCH_MAX)` cap. If
  // we ever sent more than this in one request, multer would throw
  // LIMIT_UNEXPECTED_FILE and reject the WHOLE batch (not the
  // overflow), which would silently lose the per-file pass/fail UX
  // for any backfill larger than 50. Chunking client-side keeps
  // arbitrary-size batches working the same way as small ones.
  const BATCH_CHUNK_SIZE = 50;

  const uploadChunk = async (chunk) => {
    const form = new FormData();
    for (const f of chunk) form.append('files', f);
    form.append('year', String(isoYear(new Date())));
    const r = await fetch('/api/bat/upload-batch', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const data = await r.json();
    if (!r.ok) {
      // Whole-chunk failure — surface as per-file errors so the
      // results modal still has one row per file. Without this, a
      // network/auth failure on chunk 2 of 4 would silently drop
      // those 50 files from the visible result list.
      const message = data.error || 'Batch upload failed';
      return chunk.map((f) => ({
        filename: f.name,
        status: 'error',
        error: message,
      }));
    }
    return data.results || [];
  };

  const handleBatch = async (files) => {
    setError('');
    setRejection(null);
    setBatchResults(null);
    setUploading(true);
    try {
      const allResults = [];
      for (let i = 0; i < files.length; i += BATCH_CHUNK_SIZE) {
        const chunk = files.slice(i, i + BATCH_CHUNK_SIZE);
        const chunkResults = await uploadChunk(chunk);
        allResults.push(...chunkResults);
      }
      setBatchResults(allResults);
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    // Reset the skipped notice on every new drop — last drop's
    // soft-skip warning isn't relevant once the user starts a new one.
    setSkippedNotice('');
    const accepted = filterAccepted(fileList);
    const skipped = fileList.length - accepted.length;
    if (accepted.length === 0) {
      setError('Only .xlsx or .xls files accepted');
      return;
    }
    if (skipped > 0) {
      // Soft warning — proceed with the accepted files but tell the
      // operator we dropped some. Stored in skippedNotice (separate
      // from `error`) so the upload handlers' setError('') reset can't
      // wipe it before the user reads it.
      setSkippedNotice(`Skipped ${skipped} non-spreadsheet file${skipped !== 1 ? 's' : ''} from the drop`);
    }
    if (accepted.length === 1) {
      await handleSingle(accepted[0]);
    } else {
      await handleBatch(accepted);
    }
  };

  // Convenience callbacks for the batch results modal.
  const successCount = batchResults?.filter((r) => r.status === 'success').length || 0;
  const failCount = batchResults?.filter((r) => r.status !== 'success').length || 0;
  // Auto-navigate to the most recently created recon when the operator
  // closes the modal AFTER a fully-successful batch — same instinct as
  // the single-file path: if it all worked, get them to the result.
  // The batch endpoint returns only reconciliationId per row (full
  // recon objects would balloon the response on a 50-file batch); the
  // full object is fetched here, only when navigation actually happens.
  // If the fetch fails the operator still lands somewhere sensible —
  // we close the modal without throwing.
  const closeBatchModal = async () => {
    const lastSuccess = [...(batchResults || [])].reverse().find((r) => r.status === 'success');
    setBatchResults(null);
    if (lastSuccess && failCount === 0 && lastSuccess.reconciliationId) {
      try {
        const r = await fetch(`/api/bat/reconciliation/${lastSuccess.reconciliationId}`, {
          credentials: 'include',
        });
        if (r.ok) {
          const data = await r.json();
          onComplete(data.reconciliation || data, lastSuccess.backfilled || 0);
        }
      } catch {
        /* swallow — modal already closed; operator can pick the recon from the list */
      }
    }
  };

  return (
    <div>
      <div
        className="relative border border-dashed py-10 px-6 text-center transition-colors cursor-pointer"
        style={{
          borderColor: dragging ? 'var(--phosphor)' : 'hsl(var(--border))',
          background: dragging ? 'hsla(33, 95%, 55%, 0.04)' : 'hsl(var(--card))',
          borderRadius: '12px',
        }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {uploading ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-accent" strokeWidth={1.5} />
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
              Processing spreadsheet
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <FileSpreadsheet
              className="h-7 w-7 text-muted-foreground group-hover:text-accent transition-colors"
              strokeWidth={1}
            />
            <div>
              <p className="font-display text-xl text-foreground leading-tight">
                Drop one or more supplier spreadsheets
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mt-2">
                or click to browse · <span className="text-muted-foreground/60">expected: Week_XX_…</span>
              </p>
            </div>
          </div>
        )}
      </div>
      {error && (
        <div
          className="relative overflow-hidden border border-border bg-card mt-3 px-4 py-2.5"
          style={{ borderRadius: '12px' }}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-[2px]"
            style={{ background: 'hsl(var(--destructive))', boxShadow: '0 0 10px hsla(0,72%,50%,0.3)' }}
          />
          <p className="font-mono text-xs text-destructive pl-2">{error}</p>
        </div>
      )}
      {skippedNotice && (
        <div
          className="relative overflow-hidden border border-border bg-card mt-3 px-4 py-2.5"
          style={{ borderRadius: '12px' }}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-[2px]"
            style={{ background: 'var(--phosphor)', boxShadow: '0 0 10px hsla(33, 95%, 55%, 0.3)' }}
          />
          <p className="font-mono text-xs pl-2" style={{ color: 'var(--phosphor)' }}>
            {skippedNotice}
          </p>
        </div>
      )}

      {/* Single-file rejection modal — same shape as before. Only shown
          when the single-file endpoint returned a 400 with reasons. */}
      {rejection && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={() => setRejection(null)}
        >
          <div
            className="relative max-w-2xl w-full bg-card border border-destructive overflow-hidden"
            style={{ borderRadius: '12px', boxShadow: '0 0 32px hsla(0, 72%, 50%, 0.25)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: 'hsl(var(--destructive))' }} />
            <button
              onClick={() => setRejection(null)}
              className="absolute right-3 top-3 p-1 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="px-6 py-5 pl-7">
              <div className="flex items-center gap-2.5 mb-1">
                <AlertTriangle className="h-4 w-4 text-destructive" strokeWidth={2} />
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-destructive">
                  Spreadsheet rejected
                </div>
              </div>
              <h2 className="font-display text-2xl text-foreground leading-tight">
                Nothing was saved.
              </h2>
              <p className="text-xs text-muted-foreground mt-2 break-all">
                <span className="font-mono">{rejection.fileName}</span>
              </p>

              <div className="mt-4 pt-4 border-t border-border">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-3">
                  {rejection.reasons.length} issue{rejection.reasons.length !== 1 ? 's' : ''} found
                </div>
                <ul className="space-y-2.5">
                  {rejection.reasons.map((reason, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm text-foreground">
                      <span className="font-mono text-[10px] text-destructive mt-1 flex-shrink-0">▲</span>
                      <span className="leading-relaxed">{reason}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-5 pt-4 border-t border-border flex items-center justify-end gap-3">
                <button
                  onClick={() => setRejection(null)}
                  className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Close
                </button>
                <button
                  onClick={() => { setRejection(null); fileRef.current?.click(); }}
                  className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
                  style={{
                    borderRadius: '12px',
                    borderColor: 'var(--phosphor)',
                    color: 'var(--phosphor)',
                    background: 'hsla(33, 95%, 55%, 0.08)',
                  }}
                >
                  Retry with another file
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Batch results modal — one row per file with status + details.
          Shown after a multi-file upload (≥2 files) regardless of
          outcome, so the operator sees the full picture and can pick
          out which files need re-uploading. */}
      {batchResults && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={closeBatchModal}
        >
          <div
            className="relative max-w-3xl w-full bg-card border border-border overflow-hidden"
            style={{ borderRadius: '12px', boxShadow: '0 0 32px hsla(0, 0%, 0%, 0.4)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeBatchModal}
              className="absolute right-3 top-3 p-1 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="px-6 py-5">
              <div className="flex items-center gap-2.5 mb-1">
                <FileSpreadsheet className="h-4 w-4 text-accent" strokeWidth={2} />
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                  Batch upload results
                </div>
              </div>
              <h2 className="font-display text-2xl text-foreground leading-tight">
                {successCount} succeeded{failCount > 0 ? `, ${failCount} failed` : ''}.
              </h2>

              <div className="mt-4 pt-4 border-t border-border max-h-[60vh] overflow-y-auto">
                <ul className="space-y-3">
                  {batchResults.map((result, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 text-sm text-foreground border border-border px-3 py-2.5"
                      style={{ borderRadius: '8px' }}
                    >
                      {result.status === 'success' ? (
                        <CheckCircle2
                          className="h-4 w-4 text-accent flex-shrink-0 mt-0.5"
                          strokeWidth={2}
                        />
                      ) : (
                        <AlertTriangle
                          className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5"
                          strokeWidth={2}
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs text-foreground break-all">{result.filename}</div>
                        {result.status === 'success' && (
                          <div className="font-mono text-[10px] text-muted-foreground mt-1">
                            Week {result.weekNumber}/{result.year}
                            {result.backfilled > 0 ? ` · backfilled ${result.backfilled}` : ''}
                          </div>
                        )}
                        {result.status === 'rejected' && (
                          <ul className="mt-1.5 space-y-1">
                            {result.reasons.map((reason, j) => (
                              <li key={j} className="flex items-start gap-1.5 text-xs text-destructive">
                                <span className="font-mono text-[9px] mt-0.5 flex-shrink-0">▲</span>
                                <span className="leading-relaxed">{reason}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {result.status === 'error' && (
                          <div className="text-xs text-destructive mt-1">{result.error}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-5 pt-4 border-t border-border flex items-center justify-end">
                <button
                  onClick={closeBatchModal}
                  className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
                  style={{
                    borderRadius: '12px',
                    borderColor: 'var(--phosphor)',
                    color: 'var(--phosphor)',
                    background: 'hsla(33, 95%, 55%, 0.08)',
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
