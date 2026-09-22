# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-22

### Added

- `FoldPoint` decision engine returning `KEEP` / `COMPACT` / `FORCE`.
- Cache-aware, price-aware break-even estimation (`estimatedNetSaving`, `breakEvenCalls`).
- Window safety guard (hard window ratio + reserve tokens) that overrides economics.
- Quality guards: safe boundary, host opt-out, cooldown, minimum reclaim tokens/ratio.
- Online learning via EMA: retention ratio, compaction output ratio, cache hit ratio,
  compaction cost, reuse horizon.
- Cold-start defaults in a single file (`src/defaults.ts`), all overridable.
- Per-profile state isolation, JSON-serializable state export/import.
- Structured, stable reason codes and a full metrics block on every decision.
- Unit, scenario, serialization and monotonicity/invariant test suites.
- Deterministic simulation benchmark with fixed-threshold baselines.
- Documentation: algorithm, integration, limitations.
