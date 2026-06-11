# BAT Reconciliation redesign — "Ledger Cockpit"

**Status:** Approved direction, scheduled for later (roadmap item — see `roadmap-2026-05-05.md`).
**Decided:** June 11, 2026. Sean picked this direction from a four-way design study
(4 independent layout proposals — Week Rail / Ledger Cockpit / Verification Cockpit /
One Ledger — scored by 3 judge lenses: operator workflow, design consistency,
implementation pragmatics. Ledger Cockpit won 24/30; Week Rail was runner-up at 20).

## Why a redesign

The current `src/pages/Reconciliation.jsx` (≈2,450 lines + ≈2,200 in
`src/components/reconciliation/`) has accumulated structural problems the layout
can't paper over:

- **Three competing "week landscape" surfaces** show the same weeks differently:
  DashboardOverview's KPI tiles, the ~280-line H1/H2 dual BAT-vs-Sage scroll tables
  (~56rem stacked), and the WeekSelector card grid.
- **Four different variance computations** feed different corners of the page, so
  on-screen numbers can disagree with each other. The drift-safe variant documented
  in `WeekSelector.jsx:38-42` (claim_per_fee vs per-fee Sage sums) is the correct one.
- The **Exceptions card is buried in a dead tab**; the cross-reference tab shares
  state with the per-week match fetch (`cardosoMatch` leak — opening a recon silently
  re-scopes the tab).
- **Mark-zero uses a hardcoded `isoYear(new Date())`** (`Reconciliation.jsx:1187`)
  regardless of the year being viewed.
- Five different rand formatters; ~7 copy-pasted phosphor buttons; two
  differently-built fake checkboxes; pre-redesign styling (raw shadcn orphan-prune
  dialog, native `title=` tooltips holding 200+ chars of operationally important copy).

## The design

Land the operator on the Customer Search / Creditor Balances family pattern:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ The BAT *ledger*.                   [2026 ▾] [⇪ UPLOAD BAT WEEK] [CARDOSO…] [PRINT CLAIM PACK]│
│ ● SAGE OK · 23 WEEKS UPLOADED · VIEWING 2026                            (hero, border-b pb-5) │
│                                                                                               │
│ ┌ BAT TOTAL ────────────┐┌ VARIANCE VS SAGE ─────┐┌ PODS VERIFIED ──────┐┌ WEEK ────────────┐ │
│ │ R 4 182 930,17        ││ R 12 456,78        ▲  ││ 1 412 / 1 530       ││ W23 · 2026       │ │
│ │ CLAIM · 23 WEEKS      ││ SAGE R 4 170 473,39   ││ OCR R 3 980 112,40  ││ UPLOADED W22     │ │
│ │ ▂▂ phosphor glow ▂▂   ││ ▂▂ red glow ▂▂        ││ ▂▂ green glow ▂▂    ││ PAID W21 ▂blue▂  │ │
│ └───────────────────────┘└───────────────────────┘└─────────────────────┘└──────────────────┘ │
│ ● R 4 182 930,17 claimed − R 4 170 473,39 credit notes = R 12 456,78 variance ⓘ              │
│   (hover VARIANCE → per-fee card)             ● Sage cache synced 2h ago [REFRESH SAGE CACHE] │
│                                                                                               │
│ ▌MISSING CREDIT NOTES — W14 · W19 not Sage-paid, not zero → ghost rows below    (worst-first, │
│ ▌INTEGRITY 21/23 — I1●I2●I3●I4●I5▲I6●I7◌ · W12 drift R 1 102,00 [expand ▾]     max 2 strips) │
│                                                                                               │
│ Weeks.                               [Filters ▾  ● unbalanced ×   week…   invoice…  clear all]│
│ ┌──────────────────────────────────────────────────────────────┐ ┌ EXCEPTIONS 2026 ─────────┐ │
│ │ WK │ BAT          │ CREDIT NOTES │ DIFF         │ PODS  │ ST │ │ R 86 412,55 · 214 inv    │ │
│ │ 23 │ R 187 220,10 │ R —          │ R 187 220,10 │ 12/64 │ ▲  │ │ Short-dated   96 · 45%   │ │
│ │ 22 │ R 174 002,33 │ R 173 882,10 │ R 120,23 vat?│ 58/58 │ ◐  │ │ Price claim   71 · 33%   │ │
│ │ 21 │ R 168 114,90 │ R 168 114,90 │ R 0,00       │ 61/61 │ ●  │ │ No invoice    47 · 22%   │ │
│ │ 19 │ ── missing · not Sage-paid ──  [MARK ZERO] │       │ ─  │ └──────────────────────────┘ │
│ │ 17 │ ZERO · "plant shut" · unmark  │            │       │ ─  │ ┌ CROSS-REFERENCE ─────────┐ │
│ │ 16 │ R 171 506,42 │ R 171 480,01 │ R 26,41      │ 55/57 │ ◐  │ │ scope: [2026 · All]      │ │
│ │  … │ hover row → per-fee card: Delivery/Discount│       │    │ │ 1 388 matched · 11 fixed │ │
│ │    │ /Price Adj BAT−Sage=Diff + OCR/dup signals │       │    │ │ 9 mismatch · 5 BAT-only  │ │
│ │    │ click row → Week detail                    │       │    │ │ [OPEN CROSS-REFERENCE ⇗] │ │
│ ├──────────────────────────────────────────────────────────────┤ └──────────────────────────┘ │
│ │ YEAR 2026: BAT R 4 182 930,17 − SAGE R 4 170 473,39          │                              │
│ │            = R 12 456,78 · 214 exceptions  (from shown rows) │                              │
│ └──────────────────────────────────────────────────────────────┘                              │
│  showing 9 of 23 weeks · tiles read the same rows, so figures reconcile by construction       │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
 DETAIL (phase 2, row click) — hero 'Week *23*.' + stepper ‹W22 │ W23 · 2026 ▾ │ W24› [PRINT]
 ▌OCR EXTRACTING ▰▰▰▰▰▱▱ 142/218 · #1043 Welkom · engine:GoogleVision@0 · 73s ▲  (SSE-only bar)
 │PAID R 1 102 003,44│NON-COMPL R 132 564,45│EXCEPT 9 · R 8 911,02│MISSING PODS 6 · R 14 230│
 PAID + NON-COMPLIANT = CLAIM ✓ I3 · OCR-VERIFIED R 1 087 220,10 (188/218 PODs)
 DataTable 8 cols · hover = OCR-vs-Cardoso card · click = POD Dialog (preview · edit ✎ · retry)
 In-place Dialogs: Upload (week/year CONFIRM step) · Cardoso · Cross-ref (scope chip W23|All) ·
 Mark/Unmark zero · Reset scopes · Orphan prune (phosphor re-skin) — closing always returns here
```

### Section by section

1. **Hero header** (border-b pb-5, replaces the sticky header). *"The BAT ledger."*
   font-display 5xl with the italic phosphor word. All controls share the headline
   row: Year pill, Upload BAT Week, Cardoso, and a new **Print Claim Pack** phosphor
   button — a purpose-built letterhead artifact (claim tiles + fee comparison +
   exceptions-by-reason + integrity states), the document for BAT negotiations, via
   the existing PrintableTable/PRINT_STYLE pattern. Mono [11px] subtitle is a live
   state summary (`SAGE OK · 23 WEEKS · VIEWING 2026`). Zero dead space.
2. **Hero stat tiles** (4-up, 14px radius, bottom glow bars). Merges
   DashboardOverview's 3 KPI tiles + the 4-tile week-status grid: **BAT TOTAL**
   (claim, phosphor — `supplier_total` stamped at upload, never POD-derived),
   **VARIANCE VS SAGE** (red/green; cursor hover card shows the per-fee
   Delivery/Discount/Price-Adj breakdown), **PODS VERIFIED** (green, a deliberately
   separate "verified" number family with `ocr_sum` as sub-line), **WEEK** (blue,
   uploaded/paid demoted to sub-lines). All four read ONE fetch.
3. **Headline arithmetic + freshness row** (CreditorSummary pattern, `-mt-3`):
   `● R claimed − R credit notes = R variance ⓘ`, with LastSyncedBadge for the
   Sage week cache + quiet Refresh button right-aligned on the same row.
4. **Status strips** (2px coloured left bar). Render only when non-green; worst-first,
   capped at two visible (rest folds into the integrity expand); single green
   ALL-CLEAR when healthy. Integrity expands to a compact I1–I7 glyph row (●▲◌ with
   hover explanations). Conditional OCR PAUSED / AUTO-HALTED strip.
5. **Weeks DataTable + right rail.** The big kill: the H1/H2 dual tables AND the
   WeekSelector card grid die; one shared DataTable
   (`Wk · BAT · Credit Notes · Diff (missing-VAT chip) · PODs x/y · RAG glyph`).
   Per-fee chevron expansion becomes the cursor-following hover card (the
   VendorBatchHoverCard arithmetic layout) carrying the week-card health signals.
   Missing weeks render as **ghost rows with inline [MARK ZERO]** that reads the year
   from the row (structurally fixes the hardcoded-year bug). ZERO rows show
   note + inline Unmark. CollapsibleFilterBar with URL-backed chips ("unbalanced
   only" default-on). Table footer carries the spelled-out year arithmetic computed
   from the rows actually shown. Right rail (lg:1/3): the un-buried **EXCEPTIONS**
   card + **CROSS-REFERENCE** summary card with a visible scope chip
   (`2026 · All` / `W23`) and an Open button.
6. **In-place Dialogs** (phosphor idiom, `?week=`/`?tab=` deep links, closing always
   returns to the page): Upload with a detected week/year **CONFIRM step** (fixes the
   W1/W51+ filename-parse boundary ambiguity); Cardoso; Cross-reference with its
   **own fetch/state** (kills the `cardosoMatch` leak); mark/unmark zero; reset
   scopes; orphan prune re-skinned from raw shadcn (stays strictly selection-based —
   multi-branch weeks rule).
7. **Detail view.** Phase 1: byte-identical, inheriting only the hero ("Week *23*."),
   a week-stepper pill `‹W22 | W23 · 2026 ▾ | W24›`, and shared primitives.
   Phase 2 (own PR): InvoiceMatching's 16-column table → shared DataTable at ~8
   columns; trimmed columns move to the cursor hoverCard and a row-click **POD
   Dialog** (preview JPEG, invoice edit + save, per-row retry). Above the bucket
   tabs, a mono tie-out line: `PAID + NON-COMPLIANT = CLAIM ✓ I3 · OCR-VERIFIED R x
   (n/m PODs)`. ExtractionProgress re-skins as a status strip with a glowing
   bottom-edge progress bar, fed ONLY by the cheap SSE payload — **never re-keying
   table rows per tick** (acceptance criterion; documented page-hang history).
   Finished sections collapse to one-line receipt rows.

### Hard rules carried into the build

- **BAT TOTAL = `supplier_total` stamped at upload — never re-derived from POD
  rows** (integrity I1). "Claim" and "verified/OCR" number families never share a
  tile row and are always labelled.
- Every headline figure must reconcile on screen with visible arithmetic; tiles,
  strips, glyphs and rows all read the **one** matched computation.
- Progress UI binds only to the SSE payload (no heavy refetch per tick).

## Universal quick wins (do first, regardless of layout — ~1 day PR)

1. Unify the matched computation (claim_per_fee vs per-fee Sage sums) as the single
   source; retire DashboardOverview's `|variance|<1` and ReconciliationSummary's
   cached `supplier_total−sage_total`.
2. Fix the hardcoded mark-zero year (`Reconciliation.jsx:1187`) — bind to row/filter year.
3. Give cross-reference its own fetch/state + visible scope chip (kill the
   `cardosoMatch` leak).
4. Collapse the five rand formatters into one shared en-ZA formatter (dim-R prefix).
5. Extract shared `PhosphorButton` / `StatTile` / `StatusStrip` primitives; replace
   imperative onMouseEnter/Leave style mutation with CSS hover/focus-visible
   (keyboard focus currently gets no glow).
6. Re-skin the orphan-prune Dialog to the phosphor idiom (stays selection-based).
7. Replace the two fake checkboxes with CollapsibleFilterBar chips backed by
   `useSearchParamState`.
8. Upload Dialog: detected week/year CONFIRM step before commit.
9. Flatten FileUpload's two hand-rolled fixed-overlay modals into Dialog-native
   steps (currently modal-in-modal, no focus trap).
10. Promote the 200+ char native `title=` tooltips (WeekSelector signal rows,
    No-POD badge) to styled hover cards.
11. Dead-code sweep: stale `dashTab` comment, `weekCompYear`/`archiveYear` aliases,
    mid-file `backfillMsg` + uncleaned setTimeout, ~30-line async onClick bodies,
    InvoiceMatching's diverged inline copy of useColumnWidths, empty leftover divs.

## PR phasing & effort (≈6–8 focused days, no backend changes)

| PR | Scope | Effort |
|----|-------|--------|
| 1 | Quick wins (logic only: computation unification, year fix, crossref isolation, formatter) | ~1 day |
| 2 | Dashboard rebuild: hero, tiles + arithmetic row, strips, weeks DataTable (ghost rows/hover card/footer), right rail, crossref Dialog — detail view byte-identical | ~2–3 days |
| 3 | Shared primitive extraction + orphan-prune re-skin + FileUpload modal flattening + upload confirm step | ~0.5–1 day |
| 4 | Phase 2 detail view: InvoiceMatching → DataTable + POD Dialog, ExtractionProgress → SSE-only strip, week stepper, tie-out line. Needs a verify pass against a live OCR run (SSE/refresh machinery) | ~2–3 days |

## Runner-up (kept for reference): "Week Rail"

One page organised on the weekly process — sticky stage rail
`01 WEEK → 02 UPLOAD → 03 EXTRACT → 04 MATCH → 05 CLAIM`; finished stages collapse
to one-line receipt rows, the active stage gets the space; the all-weeks landscape
IS stage 01 (a year-ledger DataTable whose row click re-scopes the page). Won the
pure-workflow lens; lost on implementation risk (stage re-scope mid-OCR, SSE
survival, exclusive-accordion danger). It converges with the winner (stepper, ghost
rows, tie-out line, SSE-only strip, POD Dialog are shared) — effectively the
winner's possible phase-3 destination if the one-page model proves out.
