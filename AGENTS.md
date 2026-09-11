# Repository contribution guide

## Scope

This repository currently implements the B1 local interactive simulation. Do not describe the mock service as a production backend or claim that external AI providers, payments, authentication, ad platforms, or arbitrary-video server-side FFmpeg processing are connected.

## Product invariants

- A trimmed Prompt is always required.
- Video duration is an integer from 5 through 15 seconds. Unsupported combinations must fail explicitly.
- Generated results enter history first. Approval and the later manual save-to-library action remain separate.
- Uploaded source assets and generated outputs retain distinct provenance.
- Unknown uploads must never receive fabricated AI analysis, tags, scene boundaries, or downloadable clips.
- Provider keys and signed media URLs must never be committed or stored in browser localStorage.

## Development workflow

Keep shared request, state, review, split, and quota rules in the existing contract/domain packages. Preserve deterministic fixtures and meaningful tests. Before proposing a change, run the checks relevant to it; before release, run `pnpm verify` and `pnpm test:e2e`.

Do not commit `.env*`, browser data, test output, caches, generated evidence, local absolute paths, or secrets. Public-facing documentation must state that this is a B1 simulation until production services are implemented and verified.

## Local delivery extension

`packages/media-processing` and `packages/delivery-workbench` implement offline MP4 normalization and a loopback-only single-operator acceptance console. This is not a production backend and does not enable paid Provider calls or replace B1. Preserve raw media, explicit human review, separate manual save, and hash-bound review invalidation. Run `pnpm test:delivery` and `pnpm test:delivery:ui` for changes here; their fixtures must remain synthetic and Provider-free.
