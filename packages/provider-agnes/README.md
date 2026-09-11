# Agnes Video Provider Adapter

This module is the first real-provider adapter experiment for AIspsc.

## Scope

- Model: `agnes-video-v2.0`
- Create: `POST https://apihub.agnes-ai.com/v1/videos`
- Poll: `GET https://apihub.agnes-ai.com/agnesapi?video_id=...`
- Auth: server-side `Authorization: Bearer <AGNES_API_KEY>`
- Current conservative task subset: text-to-video and single-image-guided video
- Current conservative duration presets: 5s and 10s
- Audio generation is rejected because it is not present in the verified model-specific request contract.

## Secret boundary

Never import this module into browser code with an embedded API key. The real smoke runner reads `AGNES_API_KEY` from the process environment. GitHub Actions must provide it through the repository Secret named `AGNES_API_KEY`.

## Deterministic verification

Adapter behavior is covered by `src/index.test.ts`. Those tests use a fake fetch implementation and a dummy token; they never contact Agnes.

## Real smoke

A real provider call is intentionally manual:

```sh
AGNES_API_KEY='<secret>' pnpm smoke:agnes
```

In GitHub Actions, use the `agnes-smoke` workflow after configuring the repository Secret. The runner performs exactly one fixed 5-second text-to-video task, polls by `video_id`, downloads the final video, computes SHA-256, and saves sanitized evidence under `artifacts/agnes-smoke/`.

Do not promote this provider to a real runtime routing binding until smoke evidence and the remaining integration gates in `docs/11_AGNES_PROVIDER_INTEGRATION.md` are satisfied.
