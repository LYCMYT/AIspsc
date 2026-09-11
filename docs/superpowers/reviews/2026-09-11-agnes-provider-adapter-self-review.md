# Agnes Provider Adapter Pre-Merge Review

## Scope reviewed

Compared `main` with `feat/agnes-provider-adapter` after deterministic CI and browser E2E validation.

## Security

- No real API key is present in source, tests, docs, workflow files, request fixtures, or artifacts configuration.
- Browser code is unchanged; `AGNES_API_KEY` is consumed only by the Node smoke runner / manual GitHub Actions workflow.
- Provider error text is redacted if it unexpectedly echoes the configured key.
- Smoke evidence intentionally excludes the Provider result URL and the key.
- Smoke artifacts are ignored by git.

## External side effects

- Normal push / pull-request workflows do not call Agnes.
- `agnes-smoke` is `workflow_dispatch` only and requires repository Secret `AGNES_API_KEY`.
- `POST /v1/videos` is never automatically retried after an ambiguous response failure.

## Capability honesty

- Agnes remains `documented`, not `smoke_tested` or `integrated`.
- `runtimeEligible=false` in the binding candidate.
- Candidate scope is limited to text-to-video and single-image-guided video.
- Reference-video, multi-reference and native-audio capabilities are not claimed.
- The adapter exposes only the documented 5s/10s presets rather than pretending to support the platform's full 5–15 second range.

## Compatibility

- Existing B1 `MockPlatform` is untouched.
- Existing frontend Provider-free demo path is untouched.
- Existing frozen dependency lock is unchanged.
- New deterministic tests are included in the root unit project.

## Verified evidence before PR

- Frozen pnpm installation passes.
- TypeScript passes.
- Agnes adapter unit tests pass after the redaction regression was observed failing first.
- Full `pnpm verify` passes on the feature branch.
- Full Playwright E2E suite passes on the feature branch before the final documentation-only commits.
- The PR workflows are the final merge gate for the final branch head.

## Known follow-up gate

A real provider call has intentionally not been claimed. After merge, configure a rotated key as GitHub Repository Secret `AGNES_API_KEY`, manually run `agnes-smoke`, inspect the sanitized artifact, and only then promote Agnes evidence to `smoke_tested` if the call succeeds.
