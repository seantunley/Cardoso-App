import React, { useState, useRef } from 'react';
import { FileSpreadsheet, Loader2, AlertTriangle, X } from 'lucide-react';

export default function FileUpload({ onComplete }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  // Structured rejection — set when the server returns a 400 with a
  // `reasons` array (the SpreadsheetValidationError path). Each reason
  // is rendered as its own bullet so the operator can fix them all
  // before retrying instead of fixing one, retrying, hitting the next.
  const [rejection, setRejection] = useState(null); // { fileName, reasons: string[] }
  const fileRef = useRef();

  const handleFile = async (file) => {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['xlsx', 'xls'].includes(ext)) {
      setError('Only .xlsx or .xls files accepted');
      return;
    }
    setError('');
    setRejection(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('year', new Date().getFullYear().toString());
      const r = await fetch('/api/bat/upload', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const data = await r.json();
      if (!r.ok) {
        // Structured spreadsheet rejection (400 with reasons array).
        // We surface every reason as a bullet so the operator can fix
        // them in one pass instead of one-at-a-time.
        if (Array.isArray(data.reasons) && data.reasons.length > 0) {
          setRejection({ fileName: data.fileName || file.name, reasons: data.reasons });
          // Reset the file input so the same file can be selected again
          // after the operator fixes it (browser otherwise treats the
          // identical filename as "no change" and onChange doesn't fire).
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
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => handleFile(e.target.files[0])}
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
                Drop a supplier spreadsheet
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

      {/* Structured rejection modal. Shown when the server returns a 400
          with a reasons array — i.e. the spreadsheet had documented
          structural defects we refuse to import. Lists every problem so
          the operator can fix them in one pass; nothing was persisted
          server-side, so a retry with the corrected file is clean. */}
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
    </div>
  );
}
