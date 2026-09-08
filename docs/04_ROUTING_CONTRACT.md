# Routing contract

## Scope

B1 uses a deterministic in-browser mock registry. Routing metadata is available only in developer diagnostics and read-only task detail; the product UI does not offer a model selector or reference-strength control. No real provider binding or credential is included.

## Task classification

Requests are classified as `COPY_GENERATION`, `IMAGE_GENERATION`, `MULTI_REFERENCE_VIDEO`, `REFERENCE_VIDEO_GEN`, `IMAGE_GUIDED_VIDEO`, or `TEXT_TO_VIDEO` from the requested mode and reference roles.

## Selection rules

Selection requires one enabled binding whose environment, task type, reference count and roles, duration, ratio, resolution, audio setting, and any declared combination limits all match the request. Matching bindings are ordered deterministically by priority, model key, then binding ID.

The router never changes the requested mode, duration, audio option, resolution, ratio, or references. If no binding supports the complete combination it returns `NO_COMPATIBLE_MODEL`. The B1 demo registry covers deterministic mock behavior only; production routing remains unimplemented and unverified.

Executable behavior lives in `packages/domain/src/routing.ts` and its tests.
