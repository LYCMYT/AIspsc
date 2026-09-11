# B1.5 Portfolio Evidence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing B1 local simulation into a public, reviewable AI product evidence package without changing the verified B1 business behavior.

**Architecture:** Keep the existing Vue + `ServiceFacade` + `MockPlatform` runtime untouched. Add a product-facing documentation layer, an evidence-status layer for model/provider research, and CI workflows that independently re-run the repository's existing verification commands. No real provider binding, authentication, production backend, or paid model call is introduced in this phase.

**Tech Stack:** Markdown, JSON evidence registry, GitHub Actions, existing Node.js 24.19.x / pnpm 12.3.4 / Vitest / Playwright toolchain.

**Spec:** Existing public contracts in `docs/03_DOMAIN_CONTRACT.md` through `docs/08_ACCEPTANCE.md`, plus the approved B1.5 direction: product evidence first, then B2 backend, then B3 real provider integration.

## Global Constraints

- Preserve all existing B1 product invariants in `AGENTS.md`.
- Do not describe the mock service as a production backend.
- Do not mark any real model/provider binding as integrated or verified without direct implementation and test evidence.
- Keep `contracts/model-registry.json` conservative; B1 real bindings remain disabled.
- Unknown uploads must not receive fabricated AI analysis, scene semantics, or provider results.
- Do not add provider keys, signed media URLs, `.env*`, local paths, or secrets.
- Current repository source remains publicly visible but is not described as open source unless a repository license is added separately.

---

### Task 1: Product-facing project narrative

**Files:**
- Modify: `README.md`
- Create: `docs/00_PROJECT_OVERVIEW.md`
- Create: `docs/01_PRODUCT_DECISIONS.md`
- Create: `docs/02_SYSTEM_ARCHITECTURE.md`

**Interfaces:**
- Consumes: current B1 facts from `README.md`, `IMPLEMENTATION_REPORT.md`, `AGENTS.md`, and contracts 03–08.
- Produces: a stable product narrative that portfolio pages and interview material can cite without overstating implementation status.

- [ ] **Step 1: Rewrite README around product value and evidence**

Lead with the business problem, public reconstruction boundary, five working product routes, product decisions, reliability/evaluation highlights, evidence/test status, architecture links, and roadmap. Keep local setup commands, but move them below the product narrative.

- [ ] **Step 2: Add project overview**

Document the target workflow, actors, business problem, product boundary, implemented scope, non-goals, and B1 → B1.5 → B2 → B3 → B4 roadmap.

- [ ] **Step 3: Add product decisions**

Record decision rationales for intent-first routing, no front-end model selector, review/save separation, provenance separation, partial success, unknown outcome reconciliation, quota reservation, conservative recognition, and public reconstruction boundaries.

- [ ] **Step 4: Add architecture document**

Describe current B1 layers and the planned adapter seam from `MockPlatform` to future `HttpPlatform`. Explicitly separate domain rules from provider/database/storage concerns.

- [ ] **Step 5: Review claims against implementation report**

Every sentence that sounds like a production claim must be traceable to current code/tests or labeled planned/not implemented.

---

### Task 2: Provider capability evidence layer

**Files:**
- Create: `contracts/provider-capability-evidence.json`
- Create: `docs/09_MODEL_CAPABILITY_MATRIX.md`

**Interfaces:**
- Consumes: logical model names from `contracts/model-registry.json` and authoritative vendor documentation.
- Produces: research evidence only. It does **not** enable any real binding and must not be consumed by B1 routing as production truth.

- [ ] **Step 1: Define evidence statuses**

Use the ordered states `unverified`, `documented`, `smoke_tested`, `evaluated`, `integrated`. `documented` means an official vendor source supports at least one claim; it does not mean API access or compatibility with this project has been verified.

- [ ] **Step 2: Add evidence records for the current logical registry**

Seedance 2.0 and Kling 3.0 may be marked `documented` only for claims supported by official sources. Other logical entries remain `unverified` unless equivalent evidence is available.

- [ ] **Step 3: Add evaluation gate**

Document that a model becomes eligible for real routing only after endpoint/model ID/schema verification, one smoke test, cost capture, output persistence, error/status normalization, and the project's small-sample evaluation.

- [ ] **Step 4: Keep runtime registry unchanged**

Do not set `enabledForReal=true` and do not populate production endpoint credentials in `contracts/model-registry.json` during B1.5.

---

### Task 3: Continuous verification

**Files:**
- Create: `.github/workflows/verify.yml`
- Create: `.github/workflows/e2e.yml`

**Interfaces:**
- Consumes: existing package scripts from `package.json`.
- Produces: independent pull-request/push evidence for deterministic verification and Chromium E2E behavior.

- [ ] **Step 1: Add verify workflow**

Use Node `24.19.0` and pnpm `12.3.4`; install with frozen lockfile; run `pnpm verify`.

- [ ] **Step 2: Add E2E workflow**

Use the same Node/pnpm versions; install dependencies and Chromium; set `PLAYWRIGHT_BROWSERS_PATH` to the repository `.cache/ms-playwright`; run `pnpm test:e2e`.

- [ ] **Step 3: Verify workflow scope**

Trigger on pull requests and pushes to `main` plus `feat/**`. Avoid secrets and paid external calls.

- [ ] **Step 4: Confirm CI executes real commands**

No `continue-on-error`, no echo-based fake success, and no skipped tests presented as pass.

---

### Task 4: Pull request verification and evidence review

**Files:**
- No product-code files.

**Interfaces:**
- Consumes: branch changes and GitHub Actions results.
- Produces: reviewable PR with exact scope and explicit remaining work.

- [ ] **Step 1: Compare branch to `main`**

Expected changed paths are limited to README/docs/contracts evidence registry/GitHub workflow files.

- [ ] **Step 2: Open pull request**

PR summary must state that no runtime B1 behavior or provider binding is changed.

- [ ] **Step 3: Run CI and inspect results**

Required evidence:

```sh
pnpm verify
pnpm test:e2e
```

Expected: exit 0 on both workflows. If GitHub Actions is blocked by platform permissions or runner availability, report `BLOCKED/NOT_RUN`; never infer pass from the previous implementation report.

- [ ] **Step 4: Review final diff**

Check for accidental production claims, secrets, real-binding enablement, or unrelated code changes.

---

## Next plan after this foundation

The next independent plan should cover the B1.5 evaluation package: `docs/10_REAL_EVALUATION_PLAN.md`, four business cases × two candidate video models, cost budget/stop conditions, evaluation record schema, and one to two bad-case reviews. Real paid calls remain a separate explicitly authorized execution step.
