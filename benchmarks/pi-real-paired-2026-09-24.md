# Pi × FoldPoint: first real-provider paired timing trial (provisional)

Date: 2026-09-24. This is an integration and hypothesis-building result, **not** a
general savings claim or evidence for an upstream Pi policy change.

## Setup and cohort

- Pi local source/bundle: 0.87.0 (`d201760ff`). FoldPoint adapter loaded in every arm.
- Provider: real DeepSeek `deepseek-flash` calls. The key stayed in the process environment;
  neither key nor conversation transcripts are part of this report.
- Pi's advertised model window was overridden **only inside fresh experiment agent directories**
  from 1M to 26K tokens, with `maxTokens = 4000`. The provider itself was not changed. This
  deliberately makes compaction observable in a short task; it is not Pi's default DeepSeek
  configuration or a test of its 1M-window performance.
- Cache warming: `off` in every arm. Same model, seed, Pi compactor, artifact check and
  pricing catalog. Three arms: Pi default threshold (reserve 16,384), early threshold alone
  (reserve 24,000), and early threshold plus FoldPoint veto (reserve 24,000).
- Tasks: `steps` reads eight 60-line chunks and records their starting line numbers; `resume`
  also re-reads the progress file before each chunk. The checker requires **exactly**
  `1, 61, 121, 181, 241, 301, 361, 421` on eight ordered lines. The synthetic `big.txt` had
  480 lines, 121,440 characters, SHA-256
  `b40f94bc3b04af47dfc4585c895f9724dcb30abb42db6360e95b74d5ee59bb19`.
- Two repetitions per task/arm (12 runs). Arm order rotated between repetitions. Each run
  had its own scratch directory, Pi settings, session and trace. An earlier `sum` connectivity
  run and one exploratory run of each long task were **excluded** from this cohort; the strict
  eight-line checker was added before the reported repetitions. The exploratory `resume` run
  notably had a cheaper early-threshold arm, illustrating run-to-run variation.

All 12 runs exited normally and passed the exact artifact check. Every trace had one complete
session and zero parse errors, unpaired decisions, unpriceable calls or unknown cache-usage
reports. Costs below are calculated from provider-reported usage with Pi's model prices in
USD, **not verified against a provider invoice**.

| Task (2 reps) | Arm | Successful runs | Ordinary calls | Successful compactions | Total estimated cost |
| --- | --- | ---: | ---: | ---: | ---: |
| steps | Pi default | 2/2 | 38 | 10 | $0.042987 |
| steps | Early threshold only | 2/2 | 38 | 9 | $0.062138 |
| steps | Early threshold + FoldPoint | 2/2 | 37 | 2 | $0.026538 |
| resume | Pi default | 2/2 | 50 | 13 | $0.061313 |
| resume | Early threshold only | 2/2 | 44 | 9 | $0.066166 |
| resume | Early threshold + FoldPoint | 2/2 | 47 | 1 | $0.028491 |

Within this narrow cohort, FoldPoint's total was $0.055029 versus $0.104300 for Pi default
and $0.128304 for the early threshold alone. The paired changes versus Pi default were
−38.3% for `steps` and −53.5% for `resume`; neither percentage should be projected to other
tasks or the normal model window. `resume` ordinary-call counts ranged from 18 to 29 in the
reported runs, so even with identical inputs and passing artifacts, execution paths differed.

The likely cost mechanism is visible, but is not yet a causal proof: across the four runs per
arm, Pi default reported 537,071 prompt tokens and 394,496 cache-read tokens (73.5%);
early threshold alone reported 470,038 and 253,696 (54.0%); FoldPoint reported **more**
prompt tokens, 815,354, but 696,960 were cache reads (85.5%). FoldPoint vetoed 71 threshold
compaction attempts and permitted three successful threshold compactions. Its policy-check
latency was 0–1 ms in these traces. Fewer compaction writes and higher cache reuse outweighed
the longer prompts at this model's prices.

## What this does not establish

1. The 26K cap is a controlled stress condition. At Pi's actual 1M DeepSeek window, these
   short tasks do not reach any threshold; a separate `sum` connectivity check showed 0
   compactions in all three arms. No gain is claimed there.
2. Two synthetic tasks and two repetitions are far too small for a robust distribution, and
   exact-line artifacts do not measure broader coding quality or user experience.
3. The three-arm comparison isolates the effect of lowering the threshold and adding vetoes,
   but does **not** compare with a well-chosen fixed late threshold. That is the next required
   baseline before claiming that the dynamic policy itself is better than tuning Pi.
4. Cache warming was held off. Pi's real warming and FoldPoint's veto interact and need a
   separate, same-warming-mode comparison on a model with a validated cache lifetime.
5. The provider-reported token usage and Pi's price catalog are not a billing reconciliation.

Next: add a guarded fixed-late-threshold comparator, add less scripted tasks and more
repetitions, then test a model whose cache lifetime is known with warming both off and on.
The FoldPoint policy should only be proposed upstream after those checks preserve task quality
and show a benefit beyond a tuned fixed threshold.
