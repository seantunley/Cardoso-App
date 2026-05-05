# Recommended upgrades (May 5, 2026)

This document lists pragmatic, low-risk upgrades to improve reliability, security, and maintainability.

## 1) Add CI quality gates (high impact)

- Add a GitHub Actions workflow that runs on PRs and main branch pushes:
  - `npm ci`
  - `npm run lint`
  - `npm run typecheck`
  - `npm run build`
  - `npm audit --audit-level=high`
- Why: the repo already has scripts for lint/typecheck/build, but they are not automatically enforced in PRs.
- Outcome: catches regressions before merge and prevents dependency vulnerabilities from silently accumulating.

## 2) Pin and automate dependency updates (high impact)

- Configure Renovate or Dependabot with weekly PRs.
- Keep lockfile-only updates separate from major-version upgrades.
- Add an "upgrade checklist" PR template requiring:
  - changelog review,
  - smoke test run,
  - rollback plan.
- Why: this project has a broad dependency surface (React, Express, MSSQL, Postgres, OCR/PDF tooling), and frequent controlled updates reduce long-tail breakage risk.

## 3) Expand test coverage for business-critical logic (high impact)

- Introduce `vitest` (frontend/unit) and add tests for:
  - `src/lib/creditLogic.js`
  - `src/lib/creditAnalysis.js`
  - `src/lib/evalFlagRules.js`
  - `src/hubPostgres/importValidator.js`
- Add API tests for key routes with `supertest`:
  - auth, records, reporting, hub sync endpoints.
- Why: these files contain high-value domain logic where regressions are expensive.

## 4) Improve runtime observability (medium-high impact)

- Standardize structured logs (JSON) across `server.js`, routes, and scheduler.
- Add request IDs and correlation IDs in middleware.
- Export basic operational metrics (request counts, latency, error rate, job success/fail).
- Why: debugging distributed sync/reconciliation behavior is much faster with correlated logs.

## 5) Harden security posture (medium-high impact)

- Validate all environment variables at startup with a `zod` schema (already a dependency).
- Review session/cookie settings for strict production defaults.
- Add a secret-scanning step in CI.
- Evaluate stricter CSP in `helmet` configuration.
- Why: prevents misconfiguration and reduces incident blast radius.

## 6) Data layer reliability upgrades (medium impact)

- Add migration smoke tests for both SQLite and Hub Postgres migration flows.
- Add idempotency checks around ETL/import scripts.
- Introduce backup/restore drill checklist and periodic verification logs.
- Why: dual data backends and import pipelines increase integrity risk without automation.

## 7) Performance optimizations for large datasets (medium impact)

- Add pagination/virtualization review for heavy tables and dashboards.
- Add query timing instrumentation in DB adapters.
- Cache selected expensive report computations with explicit TTLs.
- Why: keeps UI responsive as records grow.

## 8) Frontend architecture cleanup (medium impact)

- Incrementally migrate shared JS utilities to TS starting with pure utility modules.
- Add route-level code splitting for large pages (reports, reconciliation, hub dashboards).
- Consolidate repeated fetch/retry patterns through `@tanstack/react-query` helpers.
- Why: lowers maintenance cost and improves first-load performance.

## Suggested implementation order (next 4 sprints)

1. CI quality gates + dependency automation.
2. Tests for core domain modules + API smoke tests.
3. Observability + env/schema validation.
4. Performance and architectural cleanup.

## Definition of done for this plan

- CI workflow merged and required for PRs.
- At least 20 high-value unit tests and 10 API integration tests added.
- Structured logging + request correlation enabled in production mode.
- Monthly dependency update cadence established.
