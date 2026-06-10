// Ambient login visualisation — one of THREE modes, picked deterministically
// from the date (same seed trick as the daily login quote): stable all day,
// different tomorrow.
//   traces        — drifting phosphor oscilloscope lines with tick markers
//   constellation — slow-drifting glowing points, linked when they pass close
//   bars          — breathing ledger columns rising from the baseline
// All modes share random "colour splashes": soft radial blooms in hues that
// complement the amber (cyan/magenta/lime/violet/red-orange), drawn UNDER the
// amber geometry so the phosphor identity stays dominant.
//
// Pure decoration:
//   - aria-hidden + pointer-events-none (invisible to AT and the mouse)
//   - prefers-reduced-motion → a single static frame, no animation
//   - pauses on tab hide / unmount; ~30fps cap; tiny per-frame allocations
//   - colors read from the live --accent token so theme changes carry through
import { useEffect, useRef } from "react";

// Smooth pseudo-noise from summed sines — cheap, allocation-free, and loops
// gracefully. x is the horizontal position, t the time, k a per-trace seed.
function noise(x, t, k) {
  return (
    Math.sin(x * 0.9 + t * 0.21 + k * 7.1) * 0.42 +
    Math.sin(x * 2.3 - t * 0.13 + k * 3.7) * 0.28 +
    Math.sin(x * 4.7 + t * 0.34 + k * 1.3) * 0.18 +
    Math.sin(x * 9.1 - t * 0.08 + k * 9.9) * 0.12
  );
}

export const VIS_MODES = ["traces", "constellation", "bars"];

// Deterministic per-day pick — "random on any given day", stable within it.
export function dailyVisMode(date = new Date()) {
  const seed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  return VIS_MODES[seed % VIS_MODES.length];
}

export default function PhosphorTraces({ className = "" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mode = dailyVisMode();

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

    // ── Shared: colour splashes ─────────────────────────────────────────────
    const SPLASH_HUES = [185, 320, 95, 260, 15];
    const SPLASH_COUNT = 5;
    const splashes = [];
    const spawnSplash = (s, now) => {
      s.x = Math.random();              // fractions of w/h — survive resizes
      s.y = Math.random();
      s.r = 50 + Math.random() * 90;    // px radius
      s.hue = SPLASH_HUES[Math.floor(Math.random() * SPLASH_HUES.length)];
      s.born = now;
      s.life = 6 + Math.random() * 8;   // seconds — slow blooms, not strobes
      s.peak = 0.05 + Math.random() * 0.07; // max alpha — always subtle
    };
    for (let i = 0; i < SPLASH_COUNT; i += 1) {
      const s = {};
      spawnSplash(s, 0);
      s.born = -Math.random() * s.life; // stagger initial phases
      splashes.push(s);
    }
    const drawSplashes = (t) => {
      for (const s of splashes) {
        const age = t - s.born;
        if (age > s.life) spawnSplash(s, t);
        // Smooth in/out envelope: sin over the lifetime → 0 at both ends.
        const env = Math.sin((Math.min(age, s.life) / s.life) * Math.PI);
        const alpha = s.peak * Math.max(0, env);
        if (alpha <= 0.003) continue;
        const cx = s.x * w;
        const cy = s.y * h;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s.r);
        g.addColorStop(0, `hsla(${s.hue}, 90%, 60%, ${alpha})`);
        g.addColorStop(1, `hsla(${s.hue}, 90%, 60%, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(cx - s.r, cy - s.r, s.r * 2, s.r * 2);
      }
    };

    // ── Mode: traces ────────────────────────────────────────────────────────
    const TRACES = [
      { y: 0.78, amp: 0.055, k: 1, alpha: 0.5, width: 1.6 },
      { y: 0.52, amp: 0.085, k: 2, alpha: 0.22, width: 1.2 },
      { y: 0.30, amp: 0.060, k: 3, alpha: 0.12, width: 1.0 },
    ];
    const STEP = 6;
    const drawTraces = (t) => {
      for (const tr of TRACES) {
        const baseY = tr.y * h;
        const amp = tr.amp * h;
        ctx.beginPath();
        for (let x = 0; x <= w; x += STEP) {
          const y = baseY + noise(x / 140, t, tr.k) * amp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent(tr.alpha);
        ctx.lineWidth = tr.width;
        ctx.shadowColor = accent(Math.min(0.8, tr.alpha + 0.2));
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
        for (let i = 0; i < 3; i += 1) {
          const phase = ((t * 0.035 + i / 3 + tr.k * 0.21) % 1 + 1) % 1;
          const x = phase * w;
          const y = baseY + noise(x / 140, t, tr.k) * amp;
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

    // ── Mode: constellation ─────────────────────────────────────────────────
    // Slow-drifting glowing points, linked when within reach — reads as a
    // quiet data network. Positions in fractions so resizes don't teleport.
    const POINTS = [];
    for (let i = 0; i < 42; i += 1) {
      POINTS.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.012, // fractions per second
        vy: (Math.random() - 0.5) * 0.012,
      });
    }
    let lastT = 0;
    const LINK = 120; // px
    const drawConstellation = (t) => {
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      for (const p of POINTS) {
        p.x = ((p.x + p.vx * dt) % 1 + 1) % 1;
        p.y = ((p.y + p.vy * dt) % 1 + 1) % 1;
      }
      for (let i = 0; i < POINTS.length; i += 1) {
        const a = POINTS[i];
        for (let j = i + 1; j < POINTS.length; j += 1) {
          const b = POINTS[j];
          const dx = (a.x - b.x) * w;
          const dy = (a.y - b.y) * h;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK * LINK) {
            const alpha = 0.16 * (1 - Math.sqrt(d2) / LINK);
            ctx.beginPath();
            ctx.moveTo(a.x * w, a.y * h);
            ctx.lineTo(b.x * w, b.y * h);
            ctx.strokeStyle = accent(alpha);
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
        }
      }
      for (const p of POINTS) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = accent(0.55);
        ctx.shadowColor = accent(0.8);
        ctx.shadowBlur = 7;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    };

    // ── Mode: bars ──────────────────────────────────────────────────────────
    // Breathing ledger columns along the baseline — an abstract bar chart
    // inhaling and exhaling, rounded caps so nothing reads as a hard box.
    const BAR_COUNT = 44;
    const drawBars = (t) => {
      const gap = w / BAR_COUNT;
      const bw = Math.max(3, gap * 0.42);
      const baseline = h * 0.86;
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const x = gap * (i + 0.5);
        const n = (noise(i * 0.37, t * 0.55, 5) + 1) / 2; // 0..1
        const bh = (0.06 + n * 0.26) * h;
        const alpha = 0.10 + n * 0.30;
        ctx.beginPath();
        // Rounded-capped column: stem + arc cap.
        ctx.moveTo(x - bw / 2, baseline);
        ctx.lineTo(x - bw / 2, baseline - bh + bw / 2);
        ctx.arc(x, baseline - bh + bw / 2, bw / 2, Math.PI, 0);
        ctx.lineTo(x + bw / 2, baseline);
        ctx.closePath();
        ctx.fillStyle = accent(alpha);
        ctx.shadowColor = accent(Math.min(0.7, alpha + 0.2));
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      // Baseline hairline, fading at both ends.
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, accent(0));
      g.addColorStop(0.15, accent(0.25));
      g.addColorStop(0.85, accent(0.25));
      g.addColorStop(1, accent(0));
      ctx.fillStyle = g;
      ctx.fillRect(0, baseline, w, 1);
    };

    const MODE_DRAW = { traces: drawTraces, constellation: drawConstellation, bars: drawBars };

    const draw = (tMs) => {
      const t = tMs / 1000;
      ctx.clearRect(0, 0, w, h);
      drawSplashes(t);
      MODE_DRAW[mode](t);
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
      // One pleasant static frame — seed each splash mid-bloom so the colour
      // is visible (a fresh spawn sits at zero alpha on its envelope).
      for (const s of splashes) s.born = 12 - s.life / 2;
      draw(12_000);
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
