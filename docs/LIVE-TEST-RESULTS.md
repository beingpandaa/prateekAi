# Live validation ledger

**Release status: live acceptance is not complete.** The `voice-reliability` branch contains implementation and offline regression work. This document does not claim that Deepgram, real answer models, Google Meet, or acoustic voice-command behavior passed the acceptance matrix.

No live provider calls were made for this documentation/fixture work. No API spend was incurred by that work. This is not an account-wide usage statement and does not describe earlier manual experiments outside this ledger.

## Evidence currently available

| Check | Evidence / scope | Status |
|---|---|---|
| Unit and cross-layer regression suites | Windows local run for version 0.6.0 on 2026-10-01: 397 backend, 54 configuration, 50 answer-window, and 51 cross-layer checks passed. The cross-layer run used 15 mocked answer requests and 3 fake speech connections. | PASS offline; does not establish live acceptance. |
| Windows profile compatibility | Real `safeStorage` round trip with synthetic credentials in an isolated profile across old/new app names, rerun for version 0.6.0. | PASS; no user profile accessed. |
| Portable executable branding | Version 0.6.0 built into a fresh folder; Windows product/icon metadata checked, and packaged configuration/content smoke checks passed using an isolated profile. | PASS; unsigned development build. |
| Live English ASR and question assembly | V01–V15 with the declared device/settings and pause variants. | **NOT RUN** |
| Live Hinglish ASR and context | H01–H03, including negative numbers and zero-valued arrays. | **NOT RUN** |
| Live voice recovery and acoustic conditions | F01–F12 live equivalents; deterministic edge conditions remain injected tests. | **NOT RUN** |
| Real model answer correctness | Q01–Q10; blinded manual/main-voice/adaptive comparisons, three repetitions. | **NOT RUN** |
| Real call audio | Remote participant questions through Google Meet using computer loopback. | **NOT RUN** |
| Receiver-side screen sharing | Second participant sees the actual full-screen/window/tab share; repeat for each intended configuration. | **NOT RUN** |
| Live recognition and model timing | Separately measured assembly, queue/auth, first text, and completion. | **NOT MEASURED** |
| Provider usage/cost for the acceptance workload | Must be read from actual run/account usage, with stream count and request count. | **NOT INCURRED BY THIS VALIDATION PASS** |

Do not fill missing durations with zero, mark a skipped test passed, or replace a failed repetition with a later success. Record an untestable condition as blocked with its concrete reason. No universal screen-sharing invisibility or model-correctness claim is supported by this ledger.

One parallel cross-layer run initially failed an overly tight lower-bound check against a diagnostic timestamp (780 ms instead of at least 790 ms). The test now measures final transcript injection to answer-start with a monotonic clock, retaining a strict upper bound below 1500 ms. The corrected isolated run passed at 806 ms. This is a single synthetic-flow measurement, not a live 95th-percentile result. No production timing setting was changed to obtain it.

## Run record template

Copy one record per case/configuration/repetition into a private local test record. Commit only a reviewed, redacted summary; never commit keys, candidate profiles, recordings, or raw diagnostics.

| Field | Value |
|---|---|
| Run ID / case ID / repetition1–3 | — |
| Date/time / commit / portable version | — |
| Windows / scaling / output / microphone | — |
| Mic practice or Live call / meeting app / second device | — |
| Speech language / pause / completion and incomplete holds | — |
| Provider / main model / adaptive model actually selected | — |
| Auto-answer / voice fallback / microphone options | — |
| Exact intended script / actual final transcript | — |
| Actual assembled question and supplied context | — |
| Trigger / question ID + revision / model request count | — |
| Deterministic result / rubric score / critical failure | — |
| Speech end / final ASR / accepted / dispatched / first text / done | — |
| Cue end / cue recognized, if applicable | — |
| Stream count / listening duration / provider-reported usage | — |
| Receiver observation / sharing mode, if applicable | — |
| PASS / FAIL / BLOCKED / NOT RUN and evidence | NOT RUN |

## Summary after execution

| Group | Completed / required | Failed | Median / maximum delay | Open issue |
|---|---|---|---|---|
| V01–V15 | 0 recorded live runs | Unknown | Not measured | Live execution pending |
| H01–H03 | 0 recorded live runs | Unknown | Not measured | Live execution pending |
| F01–F12 | 0 recorded live runs | Unknown | Not measured | Live equivalents pending |
| Q01–Q10 | 0 recorded model evaluations | Unknown | Not measured | Blinded comparisons pending |
| Meet audio + receiver view | 0 recorded runs | Unknown | Not measured | Second-device validation pending |

Test scripts, timing definitions, cost controls, and pass/fail gates: [VOICE-TEST-MATRIX.md](VOICE-TEST-MATRIX.md).
