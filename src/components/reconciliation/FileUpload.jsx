import React, { useState, useRef } from 'react';
import { FileSpreadsheet, Loader2 } from 'lucide-react';

export default function FileUpload({ onComplete }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef();

  const handleFile = async (file) => {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['xlsx', 'xls'].includes(ext)) {
      setError('Only .xlsx or .xls files accepted');
      return;
    }
    setError('');
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
      if (!r.ok) throw new Error(data.error || 'Upload failed');
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
    </div>
  );
}
