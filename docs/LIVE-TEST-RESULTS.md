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

## Version 0.6.1 regression update

A reported transition from “Finishing question” back to “Listening” without a new answer prompted deterministic replay. Replay reproduced an orphan speech-start or unfinalized interim span blocking later complete questions. The recording alone does not establish that this was its exact cause.

The fix expires empty speech-start state, keeps genuinely missing text blocked, and allows a fresh full question to recover. Completion rejections now show a reason and captured excerpt in the answer window; recoverable text has an explicit submission button. The previous answer remains paired with its original question.

Backend regression results: **409 passed, 0 failed**. Configuration results: **54 passed**. Answer-window results: **55 passed**. Cross-layer results: **55 passed**, using 17 mocked answer requests and 3 fake speech connections. No real cloud requests or hardware audio capture were used. These checks cover both Auto-answer settings, second-question recovery, missing-final safeguards, held-state restoration after popup reload, and English/Hinglish fresh-question detection. Live ASR accuracy, provider timing and answer quality still require the live protocol above.

The 0.6.1 portable folder was built and its Windows product/version metadata verified. **Packaged launch check: BLOCKED** by a Windows Application Control policy on the local test PC. The executable is unsigned. No security setting was changed and the launch block was not bypassed. The earlier 0.6.0 packaged pass does not establish that 0.6.1 can launch; distribution signing/trust remains unresolved. The source-driven UI and cross-layer results above do not replace this packaged launch gate.

## Follow-up source validation — 0.6.2 (2026-10-01)

Offline regressions reproduce and address four audio-state failures: late interims reopening finalized audio, empty final Results not clearing retracted words, partial finals dropping trailing constraints, and repeated questions bypassing tail protection after an incomplete-audio recovery. Coverage includes both 800/6500 ms and 700/3000 ms pause/unfinished settings, consecutive questions, session restart, malformed timestamps, and float32 timestamp rounding. Diagnostics distinguish manual mode from missing final audio and retain the decision-time settings needed for the next live investigation.

The backend suite passed **449 tests, 0 failed**. The production cross-layer suite passed **58 checks**, using 19 mocked answer requests and 3 fake speech connections, with zero real cloud requests or hardware audio capture. New wire-level cases pass partial Results and UtteranceEnd through the actual SpeechSession parser and verify the complete constraint reaches the answer request. Council review also replayed recovery against retained expired content and confirmed no stale or duplicate submission. These are deterministic source tests, not evidence of real ASR accuracy or live model quality.

Version 0.6.2 was subsequently packaged into a fresh portable folder from source commit `73305483f521b3536559ef3247d4b552c0c4d38c`. All 20 application-asset hashes matched the manifest, including the audio-finality module. Its packaged Setup and answer-window smoke checks passed with an isolated profile and exit code 0. A normal launch then opened the updated app with the existing compatible profile; listening remained stopped and no live transcription or answer test was started.

The earlier 0.6.1 Windows Application Control block remains part of the historical record. The unmodified 0.6.2 build launched while Smart App Control remained enabled; no security policy, certificate trust, or executable fallback was changed. The reason for the differing Windows trust decisions is unknown. This establishes launch on this PC only: the build remains unsigned, other PCs may block it, and live acceptance and distribution signing remain open gates.

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
