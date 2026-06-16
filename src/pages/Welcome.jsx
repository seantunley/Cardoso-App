// src/pages/Welcome.jsx
//
// Proof-of-concept "welcome experience" showcasing two ideas on top of the
// existing Cardoso aesthetic (obsidian + bone + phosphor amber):
//   1. Glassmorphism — frosted, light-bending panels with depth.
//   2. Scrollytelling — scroll-driven parallax, diagonal reveals and a
//      perspective tilt that walk through the brand narrative into sign-in.
//
// It is a STANDALONE route (/welcome) so it doesn't touch the daily login
// flow. The ambient phosphor field from the real login is reused as the
// fixed backdrop. Everything degrades to a clean, static, fully-legible
// layout under prefers-reduced-motion (framer-motion useReducedMotion).

import { useRef } from "react";
import { Link } from "react-router-dom";
import { motion, useScroll, useTransform, useReducedMotion } from "framer-motion";
import { ArrowRight, Wallet, Receipt, Boxes, BarChart3, ChevronDown } from "lucide-react";
import PhosphorTraces from "@/components/login/PhosphorTraces";

// Shared frosted-glass surface — light-bending blur, a hairline highlight and
// a soft amber inner glow so it reads as glass over the dark phosphor field.
const GLASS =
  "relative rounded-3xl border border-white/10 bg-white/[0.045] backdrop-blur-2xl " +
  "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_24px_60px_-20px_rgba(0,0,0,0.7)]";

// A scroll-into-view reveal: slides in along a direction with a slight
// perspective tilt, settling as it enters the viewport. Static if reduced.
function Reveal({ children, dir = "up", delay = 0, className = "" }) {
  const reduce = useReducedMotion();
  const from = {
    up: { y: 60, x: 0, rotateX: 8 },
    left: { x: -80, y: 20, rotateY: 10 },
    right: { x: 80, y: 20, rotateY: -10 },
  }[dir];
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      style={{ transformPerspective: 1000 }}
      initial={{ opacity: 0, ...from }}
      whileInView={{ opacity: 1, x: 0, y: 0, rotateX: 0, rotateY: 0 }}
      viewport={{ once: false, amount: 0.35 }}
      transition={{ duration: 0.8, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

const CAPABILITIES = [
  { icon: Wallet, title: "Customer & creditor accounts", body: "Aged balances, true vendor positions including unposted batches, and credit verdicts you can explain." },
  { icon: Receipt, title: "BAT reconciliation", body: "Week-by-week matching of PODs to Sage, with OCR, exceptions and printable letterhead lists." },
  { icon: Boxes, title: "Inventory & stock cards", body: "Per-item movement history with a running balance that reconciles to the stock you actually hold." },
  { icon: BarChart3, title: "Reports & head-office hub", body: "Printable daily and monthly figures, aged trial balances, and multi-site aggregation." },
];

export default function Welcome() {
  const reduce = useReducedMotion();
  const heroRef = useRef(null);

  // Hero parallax — the headline drifts slower than the scroll and fades as it
  // leaves, the standard scrollytelling depth cue.
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : 160]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.8], [1, reduce ? 1 : 0]);
  const markY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : -80]);

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      {/* ── Fixed ambient backdrop (shared with the real login) ── */}
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 70% 50% at 18% 8%, hsla(33,95%,55%,0.10) 0%, transparent 55%), radial-gradient(circle at 85% 92%, hsla(33,95%,55%,0.05) 0%, transparent 50%)",
          }}
        />
        <PhosphorTraces />
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{ backgroundImage: "radial-gradient(hsl(var(--foreground)) 1px, transparent 1.5px)", backgroundSize: "28px 28px" }}
        />
      </div>

      {/* Skip — never trap the operator on the way to sign in */}
      <Link
        to="/login"
        className="fixed top-5 right-5 z-30 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground hover:text-accent transition-colors"
      >
        Skip to sign in →
      </Link>

      <div className="relative z-10">
        {/* ── 1. Hero ── */}
        <section ref={heroRef} className="relative flex min-h-screen flex-col items-start justify-center px-8 lg:px-24">
          <motion.img
            src="/cardoso-logo-orange.png"
            alt="Cardoso"
            className="mb-12 h-24 w-auto"
            style={{ y: markY, filter: "drop-shadow(0 0 30px hsla(33,95%,55%,0.45))" }}
          />
          <motion.h1
            style={{ y: heroY, opacity: heroOpacity }}
            className="font-display text-6xl leading-[0.95] tracking-tight xl:text-8xl"
          >
            Every <em className="text-phosphor">rand</em>,
            <br />every reconciliation,
            <br />on the record.
          </motion.h1>
          <motion.p
            style={{ opacity: heroOpacity }}
            className="mt-10 max-w-md text-sm leading-relaxed text-muted-foreground"
          >
            The operating system for Cardoso depots — quietly precise, never guessing.
          </motion.p>
          {!reduce && (
            <motion.div
              className="absolute bottom-10 left-8 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground lg:left-24"
              animate={{ y: [0, 8, 0] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            >
              <ChevronDown className="h-3.5 w-3.5" /> Scroll
            </motion.div>
          )}
        </section>

        {/* ── 2. Statement ── */}
        <section className="flex min-h-screen items-center justify-center px-8 py-24 lg:px-24">
          <Reveal dir="up" className={`${GLASS} max-w-3xl p-10 lg:p-16`}>
            <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.3em] text-accent">One platform</div>
            <p className="font-display text-3xl leading-snug lg:text-5xl">
              Customer accounts, BAT reconciliation, inventory and reports — drawn from Sage, reconciled to the cent, printed on your letterhead.
            </p>
          </Reveal>
        </section>

        {/* ── 3. Capabilities (diagonal staggered reveals) ── */}
        <section className="min-h-screen px-8 py-24 lg:px-24">
          <Reveal dir="up" className="mb-12 max-w-xl">
            <h2 className="font-display text-4xl lg:text-5xl">What it does, end to end.</h2>
          </Reveal>
          <div className="grid gap-6 sm:grid-cols-2">
            {CAPABILITIES.map((c, i) => (
              <Reveal key={c.title} dir={i % 2 === 0 ? "left" : "right"} delay={i * 0.05} className={`${GLASS} p-7 lg:p-8`}>
                <c.icon className="mb-5 h-7 w-7 text-accent" strokeWidth={1.5} />
                <h3 className="font-display text-2xl">{c.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── 4. Numbers ── */}
        <section className="flex min-h-[80vh] items-center justify-center px-8 py-24 lg:px-24">
          <Reveal dir="up" className={`${GLASS} grid w-full max-w-4xl grid-cols-1 gap-8 p-10 sm:grid-cols-3 lg:p-14`}>
            {[
              { k: "Sage", v: "Live", s: "every figure reconciles to source" },
              { k: "Multi-site", v: "Hub", s: "branches roll up to head office" },
              { k: "Audit", v: "Total", s: "who, what and when — on the record" },
            ].map((n) => (
              <div key={n.k}>
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-accent">{n.k}</div>
                <div className="mt-2 font-display text-5xl tabular-nums lg:text-6xl">{n.v}</div>
                <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{n.s}</div>
              </div>
            ))}
          </Reveal>
        </section>

        {/* ── 5. Sign-in CTA ── */}
        <section className="flex min-h-screen items-center justify-center px-8 py-24">
          <Reveal dir="up" className={`${GLASS} w-full max-w-md p-9 text-center lg:p-10`}>
            <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Ready when you are</div>
            <h2 className="font-display text-4xl leading-tight">Identify yourself.</h2>
            <p className="mx-auto mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
              Your session is one step away. The ledger has been waiting patiently.
            </p>
            <Link
              to="/login"
              className="group mt-9 inline-flex w-full items-center justify-between rounded-full border border-accent/60 bg-accent/10 px-7 py-4 transition-all duration-200 hover:border-[var(--phosphor)] hover:bg-[hsla(33,95%,55%,0.22)] hover:shadow-[0_0_18px_hsla(33,95%,55%,0.4)]"
            >
              <span className="font-mono text-xs font-medium uppercase tracking-[0.25em]">Continue to sign in</span>
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </Reveal>
        </section>
      </div>
    </div>
  );
}
