# OCR module — deferred work

A 2026-05-08 external review of the OCR pipeline (`src/services/ocrWorker.js`, parent in `src/services/batReconciliation.js`) raised nine items. Five were actioned in PRs #207 (security hardening) and #208 (observability + structured timeouts). The remaining four are recorded here so the rationale isn't lost — none are urgent today, but each has a trigger condition that would justify revisiting.

## Already shipped (for reference)

- **#1 GV header auth + tighter body-snippet** — PR #207. `?key=` → `X-Goog-API-Key` header.
- **#2 Bounded streamed download** — PR #207. `OCR_MAX_PDF_MB` env, default 25.
- **#3 SSRF guard on pdfUrl** — PR #207. Reject private/loopback/Tailscale; optional `OCR_PDF_ALLOWED_HOSTS`.
- **#4 Structured timeout codes** — PR #208. `err.code = 'OCR_TIMEOUT'`; replaces a regex-on-message classifier in the self-terminate path.
- **#8 Trace artifact** — PR #208. Worker now returns `{ source, engine, angle }` on every match; parent logs `bat.ocr.match` info entries.

## Deferred

### #5 Adaptive engine ordering

**Reviewer's idea:** collect per-site/tenant success stats and reorder OCR engines automatically (or via config), since site-specific PDFs may perform better with dynamic priority than the static GV → ocr.space → Tesseract cascade.

**Status:** deferred. Cardoso BAT is single-supplier per install — the supplier *is* BAT, and engine-ordering doesn't vary meaningfully per site. Building stats collection + reorder logic buys nothing concrete in the current shape.

**Revisit when:** a second supplier is onboarded, or if the existing `bat.ocr.engine_no_match` log shows a clear pattern of engines that consistently miss for a specific site format.

**Rough scope when revisited:** new `bat_ocr_engine_stats(site_id, engine, attempts, matches)` table, sliding-window aggregation, and a per-recon order computed at queue-fill time. The existing trace artifact (PR #208) is the prerequisite — without it we couldn't attribute matches to engines. So that groundwork is already done.

---

### #6 More rotation angles (180° / 270°)

**Reviewer's idea:** the cascade only tries `[0, 90]`. Some scan batches come upside-down. Add 180° at minimum, or run fast orientation detection (Tesseract OSD-only) and route accordingly.

**Status:** deferred pending evidence. Adding a third angle takes the cascade from 6 engines × 2 angles = 12 calls per page to 6 × 3 = 18, which extends the per-row timeout budget significantly. Worse: if all three are still missing because the page is at 270°, we've wasted 50% more time before the row gives up.

**Revisit when:** the existing `bat.ocr.engine_no_match` logs show "lots of text but no regex match" rows where the text *looks* upside-down (operator can spot this from the `text_preview` field). If that pattern is real, the right answer isn't blindly adding 180° — it's a fast Tesseract OSD orientation pre-detect (~200 ms per page) followed by routing the cascade to the detected angle. That makes 1 angle's worth of calls, not 4.

**Rough scope when revisited:** new `pdfPageOrientation(buffer)` step before the cascade; 30 s cap; if OSD returns confident orientation, run the engines at that angle only; fall back to `[0, 90, 180, 270]` if OSD itself fails.

---

### #7 Promote regex rules to externally versioned config

**Reviewer's idea:** `findInvoiceNumber` has business-critical heuristics in code. Move patterns to versioned config + per-customer test fixtures so regex changes don't need a code release.

**Status:** deferred. Cardoso is single-tenant per install. The one variability we've actually seen — 8-digit vs 9-digit invoice numbers — is already exposed via the `invoice_in_digit_length` setting. Externalising the full regex pack would add: schema validation, hot-reload, version tracking, fallback-to-defaults, regression test fixtures per pack — significant infrastructure for a problem we don't have.

**Revisit when:** a *second* invoice format actually shows up (e.g. a non-BAT supplier added to the same install, or a different SKU range using a non-`IN` prefix). At that point, the value of versioned packs becomes concrete.

**Rough scope when revisited:** `bat_settings.invoice_regex_pack` JSON column; new `findInvoiceNumberWithPack(text, pack)` that takes the pack as input; default pack matches today's hardcoded patterns exactly so the migration is value-equivalent; per-pack fixture tests.

---

### #9 Per-job cancellation token

**Reviewer's idea:** worker accepts `shutdown` only — there's no per-job `cancel(id)` primitive. Add a cancel message + cooperative checks between stages so a user can abort a single in-flight extraction.

**Status:** deferred. Two existing mechanisms cover the actual use cases:

- **Pause toggle** at the recon-runner level — claimNext respects `ocrPaused`, so in-flight rows finish but no new ones start. Covers "I want to stop the run."
- **Hard-kill watchdog** at HARD_KILL_THRESHOLD_MS (PDF_TIMEOUT + 60 s, ≈ 3 min). Force-terminates the worker for a row that's wedged.

The unmet case is "operator wants to abort *this specific* row" — niche, and the watchdog covers stuck rows automatically.

**Revisit when:** operators ask for it. The signal would be a feature request to add a "cancel this row" affordance in the in-flight UI.

**Rough scope when revisited:** new worker message `{ type: 'cancel', id }`; a `CancelToken` checked between stages (`download → pdf_text → render → engine:N@A`); stages that wrap a synchronous native call (Tesseract recognise, sharp pipeline) can't actually preempt — they'd have to ride the existing self-terminate path. So cancellation is best-effort: works cleanly on network-bound stages, falls back to "row will finish or watchdog will kill it" on native stages.

---

## Tests not yet added

The reviewer's test list is reasonable but the underlying gap is bigger: **OCR has no unit tests today** (`test/` has 6 files, none covering the OCR pipeline). The highest-value test isn't allowlist negatives — it's fixture-based:

- `test/fixtures/ocr/*.pdf` — sample PDFs covering: text-layer-only, image-only, rotated 90°, multi-page invoice, supplier-typical layout, edge-case formatting that broke real recons.
- Each fixture pinned to expected `{ invoice, source, engine, angle }`.
- Tests run `extractInvoiceFromPdf` end-to-end with mocked engine cascade (so they don't depend on live GV / ocr.space keys).

That fixture suite is the regression net. Allowlist + regex-pack tests fall out naturally if/when #3-extension or #7 land — both PR #207's allowlist and a hypothetical #7 regex pack are easy to test in isolation.

**Defer-with-note rationale:** building the fixture suite is a 1–2 day investment that doesn't unblock anything operationally. Worth doing before the next significant OCR change (whichever of the deferred items lands first), so we have a regression baseline before refactoring.

---

## Trigger summary

| Item | What would justify picking it up |
|---|---|
| #5 Adaptive engine ordering | Second supplier onboarded; OR consistent `engine_no_match` patterns per site in the logs |
| #6 More rotation angles | `text_preview` in `engine_no_match` logs frequently looks upside-down |
| #7 External regex config | Second invoice format on the same install |
| #9 Per-job cancellation | Operator feature request |
| Fixture test suite | Before whichever of the above lands first |
