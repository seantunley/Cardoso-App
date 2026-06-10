import { useEffect, useState } from "react";
import { activateCoffeeMode, launchLedgerConfetti, pulseSecretGlow, getLedgerFortune } from "@/lib/fun";

const KONAMI_SEQUENCE = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
];

const SECRET_LINES = [
  "CARDOSO LEDGER // HIDDEN ROUTINE",
  "Variance drift: contained",
  "Audit trail: sparkling",
  "Backup discipline: suspiciously excellent",
  "Operator status: trusted",
];

export default function CardosoEasterEgg() {
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandValue, setCommandValue] = useState("");
  const [commandFeedback, setCommandFeedback] = useState("");

  useEffect(() => {
    const onKeyDown = (event) => {
      // Bail out when the user is typing into a form control. This
      // handler is global (window-level), so without this gate every
      // keystroke a user makes in any input/textarea/select would
      // (a) hijack Cmd/Ctrl+K and (b) advance the Konami arrow-key
      // sequence whenever they navigate with arrow keys inside text.
      // Both are confusing user-visible disruptions during normal
      // input. The easter egg remains triggerable when no editable
      // element has focus.
      const target = event.target;
      const isEditable =
        target?.matches?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ||
        target?.isContentEditable;
      if (isEditable) return;

      // Ctrl+SHIFT+K — plain Ctrl+K belongs to the navigation command palette
      // (src/components/CommandPalette.jsx); both used to bind Ctrl+K and
      // opened stacked on top of each other.
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyK") {
        event.preventDefault();
        setCommandOpen(true);
        setCommandValue("");
        setCommandFeedback("");
        return;
      }

      const expectedKey = KONAMI_SEQUENCE[sequenceIndex];
      const nextIndex = event.code === expectedKey ? sequenceIndex + 1 : event.code === KONAMI_SEQUENCE[0] ? 1 : 0;

      if (nextIndex === KONAMI_SEQUENCE.length) {
        setSequenceIndex(0);
        setVisible(true);
        setLineCount(0);
        launchLedgerConfetti();
        pulseSecretGlow();
        return;
      }

      setSequenceIndex(nextIndex);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sequenceIndex]);

  useEffect(() => {
    if (!commandOpen) return undefined;

    const onKeyDown = (event) => {
      if (event.code === "Escape") setCommandOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen]);

  useEffect(() => {
    if (!visible) return undefined;

    const lineTimer = window.setInterval(() => {
      setLineCount((count) => {
        if (count >= SECRET_LINES.length) {
          window.clearInterval(lineTimer);
          return count;
        }
        return count + 1;
      });
    }, 260);

    const closeTimer = window.setTimeout(() => setVisible(false), 6500);

    return () => {
      window.clearInterval(lineTimer);
      window.clearTimeout(closeTimer);
    };
  }, [visible]);

  // Quiet words the console understands. Anything else gets a playful reply
  // (with a nudge toward a real word) instead of silently doing nothing —
  // before this, only "coffee" worked and every other word gave zero feedback,
  // which made the whole console look broken.
  const handleCommandSubmit = (event) => {
    event.preventDefault();
    const word = commandValue.trim().toLowerCase();
    if (!word) return;
    if (word === "coffee") {
      activateCoffeeMode();
      setCommandOpen(false);
      setCommandValue("");
      setCommandFeedback("");
      return;
    }
    if (word === "ledger") {
      setCommandOpen(false);
      setCommandValue("");
      setCommandFeedback("");
      setVisible(true);
      setLineCount(0);
      launchLedgerConfetti();
      pulseSecretGlow();
      return;
    }
    if (word === "phosphor") {
      pulseSecretGlow();
      setCommandFeedback("The glow remembers you.");
      setCommandValue("");
      return;
    }
    if (word === "fortune") {
      setCommandFeedback(getLedgerFortune());
      setCommandValue("");
      return;
    }
    setCommandFeedback("The ledger keeps its secrets. (Coffee helps. So do fortunes.)");
  };

  return (
    <>
      {commandOpen && (
        <div className="fixed inset-0 z-[1001] flex items-start justify-center bg-background/45 px-6 pt-24 backdrop-blur-sm">
          <form
            onSubmit={handleCommandSubmit}
            className="w-full max-w-lg border border-border bg-card/95 p-4 shadow-[0_0_32px_hsla(33,95%,55%,0.18)]"
          >
            <label className="mb-2 block font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
              Command
            </label>
            <input
              autoFocus
              value={commandValue}
              onChange={(event) => { setCommandValue(event.target.value); setCommandFeedback(""); }}
              placeholder="Type a quiet word"
              className="w-full border-0 border-b border-border bg-transparent py-2 font-mono text-sm uppercase tracking-[0.16em] text-foreground outline-none placeholder:text-muted-subtle focus:border-accent"
            />
            {commandFeedback && (
              <div className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
                {commandFeedback}
              </div>
            )}
          </form>
        </div>
      )}

      {visible && (
        <div className="pointer-events-none fixed inset-0 z-[1000] flex items-center justify-center bg-background/55 px-6 backdrop-blur-sm">
          <div className="relative w-full max-w-xl overflow-hidden border border-accent/60 bg-card/95 shadow-[0_0_42px_hsla(33,95%,55%,0.22)]">
            <div
              className="absolute inset-0 opacity-[0.08]"
              style={{
                backgroundImage:
                  "linear-gradient(to bottom, transparent 0, transparent 8px, hsl(var(--accent)) 9px)",
                backgroundSize: "100% 10px",
              }}
            />
            <div className="relative border-b border-border px-5 py-3 font-mono text-[10px] uppercase tracking-[0.28em] text-accent">
              Secret ledger mode
            </div>
            <div className="relative space-y-3 px-5 py-6 font-mono text-xs uppercase tracking-[0.18em] text-foreground">
              {SECRET_LINES.slice(0, lineCount).map((line) => (
                <div key={line} className="flex items-center gap-3">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  <span>{line}</span>
                </div>
              ))}
              <div className="h-4 w-2 animate-pulse bg-accent" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
