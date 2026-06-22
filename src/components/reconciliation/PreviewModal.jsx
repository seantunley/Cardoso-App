// In-app multi-page POD preview viewer.
//
// Loads the cached page images for one extraction from
// /api/bat/preview-pages/<id> and lets the operator flip through every page
// (arrow keys / on-image chevrons) and print them all. It never re-downloads or
// re-renders the PDF — it just shows the JPEGs the OCR worker + background
// renderer already cached. While the background renderer is still producing
// pages (`pending`), it polls so new pages appear without a manual refresh.

import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw, RotateCw, Printer, ExternalLink, Loader2, ImageOff } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';

export default function PreviewModal({ extractionId, open, onOpenChange, pdfUrl, title }) {
  const [pages, setPages] = useState([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [rotation, setRotation] = useState(0); // degrees: 0 / 90 / 180 / 270, applied to all pages
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    if (extractionId == null) return;
    try {
      const r = await fetch(`/api/bat/preview-pages/${extractionId}`, { credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setPages(Array.isArray(d.pages) ? d.pages : []);
      setPending(!!d.pending);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load preview');
    }
  }, [extractionId]);

  // (Re)load whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setIdx(0);
    setRotation(0);
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [open, load]);

  // Poll while the background renderer is still producing pages 2..N.
  useEffect(() => {
    if (!open || !pending) return undefined;
    pollRef.current = setInterval(load, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, pending, load]);

  const count = pages.length;
  const clampedIdx = Math.min(idx, Math.max(0, count - 1));
  const go = useCallback((delta) => {
    setIdx((i) => Math.max(0, Math.min(count - 1, i + delta)));
  }, [count]);

  // Arrow-key navigation while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, go]);

  const handlePrint = useCallback(async () => {
    if (!count) { toast.error('No pages to print yet'); return; }
    // Bake the current rotation into each page for print. rotation 0 → use the
    // image URLs directly (no canvas cost). Otherwise draw each page onto a
    // rotated canvas (dimensions swapped for 90/270) so the printed output is
    // correctly oriented regardless of paper size. The preview images are
    // same-origin, so the canvas stays untainted and toDataURL works.
    const loadImg = (url) => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    const bake = async (url) => {
      if (!rotation) return url;
      const im = await loadImg(url);
      const swap = rotation === 90 || rotation === 270;
      const c = document.createElement('canvas');
      c.width = swap ? im.naturalHeight : im.naturalWidth;
      c.height = swap ? im.naturalWidth : im.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(im, -im.naturalWidth / 2, -im.naturalHeight / 2);
      return c.toDataURL('image/jpeg', 0.92);
    };
    let srcs;
    try {
      srcs = await Promise.all(pages.map((p) => bake(p.url)));
    } catch (e) {
      toast.error(`Couldn't prepare pages for printing — ${e?.message || e}`);
      return;
    }
    // Render into a hidden, same-origin iframe (the session cookie rides along
    // for any non-baked URLs), wait for decode, then print. An iframe sidesteps
    // the pop-up blocker that window.open() trips on some setups.
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
    document.body.appendChild(iframe);
    const cleanup = () => { try { document.body.removeChild(iframe); } catch { /* already removed */ } };
    try {
      const doc = iframe.contentWindow.document;
      const safeTitle = (title || `POD ${extractionId}`).replace(/[<>&]/g, '');
      const imgs = srcs.map((s, i) => `<img src="${s}" alt="Page ${i + 1}" />`).join('');
      doc.open();
      doc.write(
        `<!doctype html><html><head><title>${safeTitle}</title>`
        + '<style>@page{margin:1cm} html,body{margin:0;padding:0}'
        + ' img{display:block;width:100%;page-break-after:always;break-after:page}'
        + ' img:last-child{page-break-after:auto;break-after:auto}</style>'
        + `</head><body>${imgs}</body></html>`,
      );
      doc.close();
      const win = iframe.contentWindow;
      const imgEls = Array.from(doc.images);
      await Promise.all(imgEls.map((img) => (img.complete
        ? Promise.resolve()
        : new Promise((res) => { img.onload = res; img.onerror = res; }))));
      win.focus();
      win.print();
      win.onafterprint = cleanup;   // unreliable across browsers…
      setTimeout(cleanup, 60000);   // …so back it with a timeout
    } catch (e) {
      cleanup();
      toast.error(`Couldn't open the print view — ${e.message}`);
    }
  }, [pages, count, title, extractionId, rotation]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-xl">{title || 'POD preview'}</DialogTitle>
          <DialogDescription>
            {count > 0
              ? `Page ${clampedIdx + 1} of ${count}${pending ? ' · rendering more…' : ''}`
              : (loading ? 'Loading…' : 'Preview')}
          </DialogDescription>
        </DialogHeader>

        <div className="relative flex items-center justify-center bg-muted/20 rounded-[2px] border border-border min-h-[55vh] max-h-[70vh] overflow-auto">
          {error ? (
            <div className="text-sm text-rose-300 p-6 text-center">
              {error}
              {pdfUrl && (
                <div className="mt-2">
                  <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="underline">Open the original PDF</a>
                </div>
              )}
            </div>
          ) : loading && count === 0 ? (
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          ) : count === 0 ? (
            <div className="text-sm text-muted-foreground p-6 text-center flex flex-col items-center gap-2">
              <ImageOff className="w-6 h-6" />
              No preview image available.
              {pdfUrl && (
                <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="underline">Open the original PDF</a>
              )}
            </div>
          ) : (
            <img
              src={pages[clampedIdx]?.url}
              alt={`Page ${clampedIdx + 1}`}
              className="max-w-full max-h-[68vh] h-auto"
              style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 150ms ease' }}
            />
          )}

          {count > 1 && (
            <>
              <button
                type="button"
                onClick={() => go(-1)}
                disabled={clampedIdx === 0}
                aria-label="Previous page"
                className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-background/80 border border-border text-foreground disabled:opacity-30 hover:bg-background"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                disabled={clampedIdx >= count - 1}
                aria-label="Next page"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-background/80 border border-border text-foreground disabled:opacity-30 hover:bg-background"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
          <div className="text-xs text-muted-foreground font-mono">
            {count > 0 ? `${count} page${count === 1 ? '' : 's'}` : ''}{pending ? ' · rendering…' : ''}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRotation((r) => (r + 270) % 360)}
              disabled={!count}
              title="Rotate left 90°"
              aria-label="Rotate left 90 degrees"
              className="inline-flex items-center px-2.5 py-1.5 rounded-[2px] border border-border text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              disabled={!count}
              title="Rotate right 90°"
              aria-label="Rotate right 90 degrees"
              className="inline-flex items-center px-2.5 py-1.5 rounded-[2px] border border-border text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[2px] border border-border text-sm text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Original PDF
              </a>
            )}
            <button
              type="button"
              onClick={handlePrint}
              disabled={!count}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[2px] border border-[var(--phosphor)] text-sm text-[var(--phosphor)] hover:bg-[hsla(33,95%,55%,0.10)] disabled:opacity-40"
            >
              <Printer className="w-3.5 h-3.5" /> Print
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
