// Ambient login visualisation — "phosphor telemetry": three slowly-drifting
// glowing traces (financial sparkline × CRT oscilloscope) with soft tick
// markers, rendered behind the editorial panel in the app's amber identity.
// Pure decoration:
//   - aria-hidden + pointer-events-none (invisible to AT and the mouse)
//   - prefers-reduced-motion → a single static frame, no animation
//   - pauses on tab hide / unmount; ~30fps cap, zero per-frame allocations
//   - colors read from the live --accent token so theme changes carry through
import { useEffect, useRef } from "react";

// Smooth pseudo-noise from summed sines — cheap, allocation-free, and loops
// gracefully. x is the horizontal position, t the time, k a per-trace seed.
function trace(x, t, k) {
  return (
    Math.sin(x * 0.9 + t * 0.21 + k * 7.1) * 0.42 +
    Math.sin(x * 2.3 - t * 0.13 + k * 3.7) * 0.28 +
    Math.sin(x * 4.7 + t * 0.34 + k * 1.3) * 0.18 +
    Math.sin(x * 9.1 - t * 0.08 + k * 9.9) * 0.12
  );
}

export default function PhosphorTraces({ className = "" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Resolve the accent token ("33 95% 55%") into usable hsla() strings.
    const raw = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "33 95% 55%";
    const accent = (alpha) => `hsla(${raw.split(/\s+/).join(", ")}, ${alpha})`;

    let raf = 0;
    let running = true;
    let last = 0;
    let w = 0;
    let h = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // Trace definitions: vertical anchor (fraction of height), amplitude,
    // speed seed, alpha. The brightest trace sits low, echoing the page's
    // baseline sparkline; the faint ones recede into the wash.
    const TRACES = [
      { y: 0.78, amp: 0.055, k: 1, alpha: 0.5, width: 1.6 },
      { y: 0.52, amp: 0.085, k: 2, alpha: 0.22, width: 1.2 },
      { y: 0.30, amp: 0.060, k: 3, alpha: 0.12, width: 1.0 },
    ];
    const STEP = 6; // px between sample points — smooth without burning CPU

    const draw = (tMs) => {
      const t = tMs / 1000;
      ctx.clearRect(0, 0, w, h);
      for (const tr of TRACES) {
        const baseY = tr.y * h;
        const amp = tr.amp * h;
        ctx.beginPath();
        for (let x = 0; x <= w; x += STEP) {
          const y = baseY + trace(x / 140, t, tr.k) * amp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent(tr.alpha);
        ctx.lineWidth = tr.width;
        ctx.shadowColor = accent(Math.min(0.8, tr.alpha + 0.2));
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Tick markers: a few slow-moving bright points riding the trace —
        // reads as live measurements without implying real data.
        for (let i = 0; i < 3; i += 1) {
          const phase = ((t * 0.035 + i / 3 + tr.k * 0.21) % 1 + 1) % 1;
          const x = phase * w;
          const y = baseY + trace(x / 140, t, tr.k) * amp;
          ctx.beginPath();
          ctx.arc(x, y, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = accent(Math.min(0.9, tr.alpha + 0.35));
          ctx.shadowColor = accent(0.9);
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
    };

    const loop = (ts) => {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (ts - last < 33) return; // ~30fps is plenty for an ambient layer
      last = ts;
      draw(ts);
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reduceMotion && !running) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    };

    resize();
    if (reduceMotion) {
      draw(12_000); // one pleasant static frame
    } else {
      raf = requestAnimationFrame(loop);
      document.addEventListener("visibilitychange", onVisibility);
    }
    window.addEventListener("resize", resize);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full pointer-events-none ${className}`}
    />
  );
}
