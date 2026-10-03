# Short/medium runtime sensitivity — synthetic, not quality evidence

Run `npx tsx benchmarks/runtime-robustness.ts`. The deterministic 36-case matrix pairs
nominal-only economics with the new guard: 3/8/20 calls, zero/8k growth, warm/cold TTL,
and unknown/bounded/overstated horizons. Same tasks, prices, compactor and growth in both arms.
The 256k window starts with 80k tokens. All generated usage is synthetic; paid calls = 0.

| Horizon input | Arm | Simulated cost | Attempts | Unneeded / judged | Overflows |
| --- | --- | ---: | ---: | ---: | ---: |
| Unknown | Nominal | 26.9534 | 2 | 0 / 0 | 0 |
| Unknown | Guarded | 26.9534 | 2 | 0 / 0 | 0 |
| Bounded | Nominal | 9.8384 | 22 | 5 / 22 | 0 |
| Bounded | Guarded | 11.8447 | 13 | 0 / 13 | 0 |
| Overstated | Nominal | 8.4263 | 32 | 9 / 32 | 0 |
| Overstated | Guarded | 11.8585 | 25 | 9 / 25 | 0 |

The guard reduces attempts, but costs **more** in both declared-horizon groups. Bounded
horizons have remaining-step knowledge unavailable to Pi. Overstated inputs deliberately
stay at 30 even near task end: the guard does not fix this gross forecasting error, and
its unneeded count does not improve. Unknown horizons make only safety compactions and
remain unchanged. These results are not evidence of superiority over Pi, or preserved quality.

The parameters were not fitted against this matrix. The purpose is to expose cost/attempt
trade-offs and horizon dependence, not to make every row win. Raw per-case data:
`reports/runtime-robustness-report.json`. Settlement is the existing independent shadow
interval; it is not a whole-task quality or optimal-policy oracle. Fixed-threshold comparisons
remain in the separate eleven-scenario benchmark.
