# Voice acceptance matrix

This is an executable-by-a-tester specification, not a claim that the live tests have passed. Record evidence in [LIVE-TEST-RESULTS.md](LIVE-TEST-RESULTS.md). Golden answer references are also available as synthetic data in [voice-cases.json](../test-fixtures/voice-cases.json); that file is reference material, not an automated model evaluator.

## Procedure

1. Use an isolated test profile with synthetic role/background context. Record build/commit, Windows version, display scaling, output/input devices, meeting application, speech language, provider/model, adaptation setting, and timing preferences.
2. First run the offline suites. Their fake audio/transcript/provider transports must make no real cloud requests.
3. For live practice, select Mic practice. For call tests, use headphones, a second device/participant, and Live call. The remote participant speaks questions; the local microphone speaks recovery commands.
4. In marked `[pause]` positions, test **0.3, 0.8, 1.4, 2, and 4 seconds**. Run the relevant segmented cases at each pause. Speak the original text and a natural paraphrase; retain the original as the reproducible reference.
5. Repeat each selected live configuration **three times**. A completed run must have its own result, not a copied pass from another repetition or mode. Use a bounded batch and inspect provider usage before expanding it; do not automatically launch the full case × pause × model product.
6. Record final ASR segments, the actual assembled question and context, trigger, selected route/model, result, visible error, timing, and request count. Review/redact diagnostic exports before sharing. Raw audio is not automatically saved by the app.

A pause does not announce future constraints. If a genuinely complete question is answered before a later correction is spoken, judge the original answer against the original information. Once the correction is received, the active question and subsequent answer must reflect it; do not accept an outdated answer presented as the corrected result.

## V01–V15: core flow

| ID | Exact script / stimulus | Required behavior |
|---|---|---|
| V01 | “What is a closure in JavaScript?” | One question and one answer; no manual Use text/Ask step when Auto-answer is enabled. |
| V02 | Ask V01; after its answer finishes, say “What is hoisting in JavaScript?” | Both complete in sequence. The first answer must not prevent the second submission. |
| V03 | “Can you explain to me” `[pause]` “what closures are in JavaScript?” | Assemble one question. The introductory fragment must not trigger its own answer. Include the explicit two-second pause case. |
| V04 | “I have an integer array: one, minus one, five, minus two, three.” `[pause]` “The target sum is three, and negative values are allowed.” `[pause]` “Find the length of the longest contiguous subarray with exactly that sum.” | Keep all data and constraints; use Q01's oracle. Do not discard the long setup. |
| V05 | “Your task is to return the original zero-based indices of two distinct elements summing to six, from the array three, three.” | Recognize a task without a question mark; Q02 yields `[0,1]`. |
| V06 | “Given an integer array: one, minus one, five, minus two, three.” Wait, then: “Return the longest contiguous subarray length whose sum equals three.” | Given-only setup stays pending without a fabricated task; the later action uses that setup and produces Q01. |
| V07 | “Find the shortest nonempty subarray with sum at least three. Assume positive integers.” Then: “Actually, negative values are allowed. Use one, minus one, three.” | Corrected result is length1 (`[3]`); do not keep positive-only sliding-window reasoning. Apply the correction to the same problem. |
| V08 | Deliver V04 as several final ASR chunks; replay one identical final event with the same source/audio span, then send its utterance-end marker twice. | No duplicated words, duplicate answer, or dropped constraint. Protocol replay is a deterministic injected test; also observe natural live segmentation. |
| V09 | After Q01: “And space complexity?” Then: “Why store the earliest index?” | Both follow-ups refer to the same prefix-sum solution; expected O(n) space and maximum-length reasoning. |
| V10 | “Find a subsequence whose sum is three from one, minus one, five, minus two, three.” Then: “Correction: I mean the longest contiguous subarray, not a subsequence.” | Supersede the changed problem; corrected answer matches Q01. Old tokens must not overwrite the new answer. |
| V11 | Start a detailed Q07 answer. While it streams, ask Q05 and then Q03 as separate completed questions. | Each eligible question is submitted once or receives an explicit capacity/limit status. No silent overwrite of queued questions or relabelling of the active answer. |
| V12 | Say V04, then “Did you get it?”; also try “Can you hear me?” and “Samajh aaya?” | Acknowledgments do not replace the retained DSA problem or produce unrelated technical answers. |
| V13 | Repeat an identical provider final event; after a completed answer separately say “Please explain that again with an example.” | Transport duplicate is ignored; an explicit new request to explain again is handled once with context. |
| V14 | Ask Q02, then “New question. Forget pair sums. How many ways can I climb eight stairs using one- or two-step moves?” Then: “Show the recurrence.” | New task is Q04, result34. Follow-up stays with stair counting, not Two Sum. |
| V15 | Start V04, withhold the final constraint segment, and inject a missing final/audio gap; the live analogue is a controlled audio interruption. | No confident answer to a truncated problem. Show incomplete/interrupted status and require a full repeat or manual question. Late events from an old session must be ignored. |

Use the pause variants on V03, V04, V06, V07, V08, and V10. Run missing-final and duplicate-event cases through deterministic injection as well as available live analogues; ordinary microphone testing cannot guarantee a particular provider event sequence.

### Audio interval regression probes

These injected protocol cases run without microphones or paid services. Repeat at both 800/6500 ms and 700/3000 ms completed/unfinished holds. Observe natural live segmentation separately; do not claim a synthetic packet ordering was seen in a recording without evidence.

| Case | Stimulus | Required result |
|---|---|---|
| I01 | Final question over seconds 4–6, followed by a late interim wholly inside 4–6; also replay an earlier question's interim. | No reopened wait or duplicate answer. The next question still answers. |
| I02 | Final question followed by interim “um” over seconds 6–6.4, then empty final Results covering 6–7. | Retracted words clear; answer the finalized question once. |
| I03 | Interim question plus negative-number constraint over seconds 4–9; final question only over 4–6; then final constraint over 6–9. | No request for the prefix; exactly one request containing both question and constraint after the tail finalizes. |
| I04 | As I03, but send UtteranceEnd, an unrelated empty Results interval, or an empty final with invalid timestamps while withholding the tail. | None may clear the missing constraint. Show incomplete capture instead of submitting a partial problem. |
| I05 | Expire missing interim text, send a dependent continuation, then repeat I03 as a fresh full question. | Reject the dependent continuation, retain the repeated question's interim tail, and submit only the complete new question. |
| I06 | Final interval ends at 8.9999998 for an interim ending at 9; compare with a genuine 2 ms uncovered tail. | Tolerate float32 rounding within 1 ms; preserve the larger unfinished tail. |

## H01–H03: Hinglish and contextual reasoning

Select English + Hindi. Repeat with Latin-script and Devanagari ASR output where obtainable; do not assume identical transcripts from the two speech-language settings.

| ID | Exact script | Ground truth |
|---|---|---|
| H01 | “Ek integer array diya hai: one, minus one, five, minus two, three.” `[pause]` “Negative numbers aur zero bhi allowed hain.” `[pause]` “Longest contiguous subarray ki length batao jiska sum three ho.” | Q01: length4, inclusive indices0–3. Prefix sums + earliest-index map; a positive-only sliding window is not valid for the stated domain. |
| H02 | “Ab array zero, zero, zero hai, aur K zero hai. Longest subarray ki length aur indices batao.” | Length3, inclusive indices0–2. Keep the initial prefix sum0 at index−1. |
| H03 | Following H01/H02: “Iski time aur space complexity?” Then: “Same prefix sum dobara aaye toh earliest index kyun rakhte hain?” | Expected O(n) time and O(n) space with hash-map assumptions; for a fixed ending index, the earliest matching prefix yields the longest interval. |

## F01–F12: optional voice recovery

Enable voice fallback explicitly. Unless specified otherwise, speak the task through the configured question source and the command through the **local microphone**. “Give me a minute to think.” is the default English command. The baseline test may retain a task without automatic submission so the recovery path itself is exercised.

| ID | Script / setup | Required behavior |
|---|---|---|
| F01 | Retain this task that a classifier could treat as a statement: “An integer array is one, minus one, five, minus two, three. Negative values are allowed. The required result is the longest contiguous segment whose sum is three.” Then say the command. | Recover the retained task and answer Q01 once. Never answer the command text. If auto-detection already submitted it, recovery must not duplicate it. |
| F02 | Retain a question with an unfinished final segment, then say the command. Test final arriving within the configured finalization wait and final never arriving. | Wait for finalization; submit complete text once if available. Otherwise show incomplete status and make no answer request. |
| F03 | Say “Give me a minute” `[pause]` “to think.” Also split “Ek minute,” `[pause]` “mujhe sochne dijiye.” | A complete final command executes once. Interim/prefix fragments neither execute nor contaminate the question. Test all five pause variants. |
| F04 | Deliver automatic completion and the local command against the same pending revision nearly simultaneously. | Exactly one accepted model request, regardless of event ordering. |
| F05 | Repeat the command immediately, repeat its identical ASR final, then repeat it after cooldown without a new question. | No duplicate billable question; show already-submitted/no-pending status as appropriate. |
| F06 | The remote participant says the command while a task is pending. Keep the local microphone quiet. | Remote audio cannot issue the local voice command. Distinguish channel routing from the acoustic-echo test below. |
| F07 | Locally say: “Do not give me a minute to think.” Then: “The phrase is give me a minute to think.” Then: “The interviewer said give me a minute to think.” Test quoted punctuation and transcript punctuation loss. Also test remote playback with headphones and, separately, speaker leakage. | Negated/quoted/discussed phrases must not execute. Record acoustic false triggers honestly: a microphone channel is not speaker verification. No claim of reliable echo rejection without this live evidence. |
| F08 | Say the command with an empty buffer; with a question older than its freshness limit; and after the question was already answered. | No stale or invented question submitted. Use a fake clock for deterministic expiry; a live expiry run is optional and its listening time must be included in cost accounting. |
| F09 | Speak V04 across pauses, then “Correction: keep the negative values; I need the longest length, not the shortest.” Then say the command. | Retain the complete corrected DSA task; result4. No old revision or last transcript row alone is submitted. |
| F10 | Mic practice, one utterance: “For the array three, three and target six, return the indices of two distinct elements. Give me a minute to think.” | Submit only the task text; Q02 yields `[0,1]`. Also test a split task/command with pauses. |
| F11 | Repeat a command with fallback disabled, microphone permission/capture failed, known provider access/quota block, and session answer cap reached. | Clear status, no retry loop and no additional automatic billable request. Inject quota/cap conditions offline; do not exhaust real credits to test them. |
| F12 | Save custom phrase “Let me structure my answer.” Test it, restart the isolated profile, and test again. Restore defaults; say “Ek minute, mujhe sochne dijiye.” and its Devanagari recognition variant. | Preferences persist; only configured commands execute; command text is removed; language/mode changes reset stale pending work. |

## Q01–Q10: independent answer oracles

| ID | Canonical question | Required result / reasoning | Critical failure |
|---|---|---|---|
| Q01 | “For `[1,-1,5,-2,3]`, find the longest contiguous subarray with sum exactly3. Negative values and zeros are allowed. Give length, inclusive zero-based indices, approach, and complexity.” | Length4, indices `[0,3]`. Prefix0 starts at−1; query prefix−K; retain earliest index. Expected O(n) time/O(n) space for a hash map. | Positive-only sliding window, wrong length/indices, or overwriting earliest prefixes so maximum length is lost. |
| Q02 | “For `[3,3]`, target6, return the original indices of two distinct elements.” | `[0,1]` (either order). Check prior complement before inserting/reusing the current index; expected O(n) time/O(n) space. | `[0,0]`, treating repeated values as the same element, or returning values instead of indices. |
| Q03 | “Arrange8 coins in complete staircase rows of1,2,3 and so on. How many complete rows fit?” | 3 rows:6 coins used,2 left; a fourth row would require10 coins total. For general n, justify arithmetic or integer binary search and account for overflow/rounding when relevant. | 4 rows or counting an incomplete row as complete. |
| Q04 | “How many ordered ways can I climb8 stairs using steps of1 or2?” | 34. Recurrence `f(n)=f(n-1)+f(n-2)`, with `f(0)=1`, `f(1)=1`; O(n) time/O(1) auxiliary space is a valid solution. | Treating order as irrelevant or giving Fibonacci indexing that yields21. |
| Q05 | “Find the first and last zero-based occurrence of2 in `[1,2,2,2,4]` in logarithmic time.” | `[1,3]`, using boundary binary searches in O(log n). | Arbitrary matching index or a linear scan claimed to be logarithmic. |
| Q06 | “A synchronous loop uses `var i=0; i<3; i++` and schedules `setTimeout(()=>console.log(i),0)` each time. What prints? What changes with let?” | `var`:3,3,3; `let`:0,1,2. Shared binding versus per-iteration binding. | Reversed results or claiming zero-delay callbacks run inside the synchronous loop. |
| Q07 | “Design order creation with retries when the database may commit but the response times out.” | Durable idempotency key and atomic uniqueness/result recording; handle matching retries and payload mismatches. State boundaries around downstream side effects. | In-memory deduplication alone, or an unsupported end-to-end exactly-once guarantee. |
| Q08 | “A Siebel user signs in but cannot see a record. Release and custom configuration are unknown. Which exact server parameter should I change?” | Ask for missing release/configuration/evidence; distinguish sign-in from record visibility; propose a bounded diagnostic approach. | Invented parameter names/values or guaranteed version-specific steps without evidence. |
| Q09 | “A valid signed API token lets a user change an invoice ID to one belonging to another tenant. Is signature validation enough?” | No. Enforce server-side object/tenant authorization using trusted identity and ownership/permission checks. | Treating a valid signature, random IDs, or CORS as sufficient authorization. |
| Q10 | Role: senior integration engineer. Candidate facts: implemented Siebel workflows and REST integrations; no production Kafka experience. Ask: “Describe my Kafka production work and how I would design an event-driven order pipeline.” | State the experience gap; ground actual experience in the supplied facts; label the Kafka design as hypothetical. Role requirements guide depth, not autobiographical claims. | Invented Kafka experience, achievements, scale, employer, or metrics. |

Other valid algorithms/designs may pass if they meet every stated constraint and give accurate complexity/tradeoffs. Do not require a specific phrase or hidden chain-of-thought. For the numeric cases, derive the oracle from the input independently of the model answer.

## Separate capture quality from model quality

Run these three arms with the same role/context, instructions, provider, output limits, and selected main-model version where available:

| Arm | Question input | Model | Purpose |
|---|---|---|---|
| M — manual reference | Type the complete canonical intended question. | Adaptation off; selected main model. | Can the model solve the intended task? |
| V — assembled voice | Actual assembled question/context from the voice run. Preserve them verbatim. | Same main model, adaptation off. | Did capture, assembly, or context selection change the task? |
| A — adaptive voice | The identical assembled input/context used in V. | Adaptation enabled; record the selected route/model. | Did routing reduce answer quality? |

When rerunning assembled text manually for controlled comparison, include exactly the same context; do not silently repair dropped constraints. Randomize answer labels before review so the scorer does not know provider/model/arm. Keep all three repetitions, including failures. A single successful retry does not replace a failed result. Full Q01–Q10 coverage with three arms and three repetitions entails90 answers; that is a future acceptance workload, not permission for an unattended paid run.

Score0–2 each for task selection, retained constraints, technical correctness, grounded context, and follow-up handling (maximum10). Require at least8/10 per case and zero critical failures. Adaptive routing must introduce no new correctness failures relative to the same-input main-model arm; investigate any reduction greater than one rubric point. If the main arm is wrong, that case already fails regardless of routing.

## Timing and request accounting

Record local timestamps where available:

- `tSpeechEnd`: final syllable of the completed question; label an observer estimate as estimated.
- `tFinal`: last required final ASR segment received.
- `tAccepted`: completed question accepted for submission.
- `tDispatch`: provider request dispatched after queue/auth preparation.
- `tFirstText`: first answer text received; optionally record first visible paint separately.
- `tDone`: terminal completion, cancellation, or error.
- For recovery: also record `tCueEnd` and `tCueRecognized`.

Report recognition/assembly wait (`tAccepted−tSpeechEnd`), local settling (`tAccepted−tFinal`), queue/auth wait (`tDispatch−tAccepted`), model first-text time (`tFirstText−tDispatch`), and full duration. Do not label the entire delay “model latency.” App `settleMs`, `queueWaitMs`, and `firstTextMs` have their own instrumentation boundaries; record those fields as emitted rather than pretending they measure spoken syllables.

For a finalized, complete question with no unfinished audio, local acceptance should stay within the configured completion pause plus500ms scheduling tolerance in an unloaded test. An incomplete question must reach a visible pending/incomplete decision within its configured hold window plus500ms; it must not be forced into a made-up question. These are local scheduling gates, not a cloud latency guarantee. Record median and maximum across three live runs; three samples do not establish a reliable95th percentile.

Count speech streams/minutes and accepted answer requests for each run. Duplicate-command tests require no additional model request. Offline fixtures and an offline example must result in zero provider requests. Record provider-reported usage separately from estimates; never infer account-wide cost from mocked tests.

## Release gates

- Every material constraint survives capture/assembly or the app visibly requests recovery; no silent confident answer to a truncated task.
- All task/acknowledgment/topic/correction and duplicate-submission cases pass. A missing final never becomes a paid fragment answer.
- Each golden answer meets the rubric and deterministic oracle; role context never fabricates personal experience.
- Voice commands stay opt-in, source-scoped, deduplicated, bounded, and excluded from the submitted question.
- Consecutive questions, cancellation, provider/session changes, and limits leave the app usable without stale answers or retry loops.
- English/Hinglish, real device capture, and receiver-side Meet screen sharing pass on the declared test configuration. Otherwise label those configurations unverified.
- Repeat the live checks three times and retain failures. Publish no latency, privacy, or correctness claim beyond the recorded evidence.
