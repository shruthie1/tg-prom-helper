# Channel Message Promotions Audit Monitor

Use this monitor to supervise repeated audits of `src/channel-message-promotions`, shared `src/types`, and the related tests. The goal is convergence: keep running full iterations until practical scenario drift and newly found gaps stop appearing.

## Monitor Objective

The monitor owns the audit loop. Each iteration must inspect the same surfaces, compare behavior against practical production scenarios, record findings, apply fixes when needed, and decide whether another iteration is required.

An audit is complete only when the monitor sees two consecutive clean iterations.

## Iteration Steps

Every iteration runs these steps in order:

1. **Inventory sweep**
   - List all production and test files under `src/channel-message-promotions`, `src/types`, and `tests`.
   - Confirm each production file maps to one checklist area.
   - Confirm every public export is intentional and package-root reachable.

2. **Contract sweep**
   - Check public constructors, runtime factories, policies, selection APIs, queues, Redis services, attribution, intelligence, scoring, and type exports.
   - Verify malformed top-level inputs either fail fast for required dependencies or degrade safely for optional/runtime data.
   - Verify `exactOptionalPropertyTypes` compatibility and no stale compatibility paths.

3. **Practical scenario drift sweep**
   - Compare current code and tests against the practical scenario matrix in `channel-message-promotions-functional-audit-checklist.md`.
   - Add a scenario when a realistic production path is not represented.
   - Treat any untested high-risk production branch as drift.

4. **Failure-mode sweep**
   - Review Mongo, Redis, Telegram adapter, queue, timer, observer, logging, and analytics failure paths.
   - Confirm send/follow-up/deletion accounting cannot loop forever, double-count, block unrelated channels, or hide terminal failure.
   - Confirm multi-account state remains isolated by normalized `mobile` and `clientId`.

5. **Algorithm sweep**
   - Review selection, batch sizing, delay, eligibility, follow-up, message strategy, expected value, classifier, percentile, and attribution logic.
   - Confirm malformed numeric state cannot produce `NaN`, negative counters, out-of-range rates, runaway delays, or accidental premium-only behavior.
   - Confirm conversion attribution only records paid conversions for `isPaid === true`.

6. **Fix and evidence sweep**
   - Fix every production-relevant gap found in the iteration before moving on.
   - Add or update focused tests for each code fix.
   - Record the finding, fix, and validation command evidence.

7. **Monitor verdict**
   - Mark the iteration **dirty** if any new production gap, practical scenario drift, checklist addition, missing test, or code fix was found.
   - Mark the iteration **clean** only if no new gap or drift was found and all selected validation gates pass.

## Stop Rule

Stop only after two consecutive clean iterations.

Reset the clean-iteration counter to zero when any of these happens:

- A new practical scenario is added.
- A production code change is required.
- A test gap is found.
- Public exports or package shape changes.
- Type checking or tests fail for reasons related to the promotion helper.
- The checklist itself gains a new uncovered audit item.

## Severity Rules

| Severity | Rule | Required action |
| --- | --- | --- |
| P0 | Could send incorrectly, attribute incorrectly, break runtime startup, leak account state, or lose required persistence. | Fix immediately, add regression tests, rerun full gates. |
| P1 | Could skip valid promotions, loop/retry incorrectly, over-throttle, under-throttle, or hide operational failure. | Fix in current iteration, add focused tests, rerun targeted plus type gates. |
| P2 | Could reduce observability, produce confusing metrics, or leave a realistic scenario undocumented. | Fix or document in current iteration, rerun affected gates. |
| P3 | Code organization, naming, or maintainability issue with no behavioral risk. | Fix when local and low risk, otherwise record as follow-up. |

## Evidence Format

Use this format in audit notes or final summaries:

```text
Iteration N:
- Inventory: clean|dirty - evidence
- Contracts: clean|dirty - evidence
- Practical scenarios: clean|dirty - evidence
- Failure modes: clean|dirty - evidence
- Algorithms: clean|dirty - evidence
- Fixes: none|summary
- Validation: commands and result
- Monitor verdict: clean|dirty
```

## Required Validation Gates

For a final clean monitor verdict, run:

- `npm run typecheck`
- `npm run typecheck:tests`
- `npm run typecheck:declarations`
- `npm run test:ci`
- `npm run prepublishOnly`
- `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run`
- `find src -type d -empty`

When `mongodb-memory-server` cannot bind inside the sandbox, rerun `npm run test:ci` with the approved escalated command.

## Latest Run Evidence

Run: 2026-05-31 repeated five-iteration functionality/logic audit with available-message normalization, percentile negative-counter clamps, and send-failure discount alignment.

Iteration 1:
- Inventory: clean - source/test/docs inventory, package-root exports, hard-cut folder layout, empty-folder scan, and debug/TODO/focused-test scan remained consistent.
- Contracts: clean - public APIs remained package-root reachable and no stale compatibility paths were found.
- Practical scenarios: clean - no drift found in the checklist/file ownership pass.
- Failure modes: clean - no empty source folders or debug/focused test markers.
- Algorithms: clean - not changed in this iteration.
- Fixes: none.
- Validation: `rg --files`, `find src -type d -empty`, debug/TODO/focused-test scan.
- Monitor verdict: clean.

Iteration 2:
- Inventory: dirty - public message policy and runner flow trusted `availableMessageIds` / `availableMsgs` to be arrays.
- Contracts: dirty - untyped package consumers could pass a string/object available-message list and trigger candidate planning errors or incorrect queue available-message counts.
- Practical scenarios: dirty - malformed channel snapshots from adapters could queue an incorrect `availableMessageCount` after a send.
- Failure modes: dirty - malformed available-message input could break direct policy calls or skew deletion policy context later.
- Algorithms: clean - valid available-message selection behavior unchanged.
- Fixes: message policy now treats non-array available-message lists as empty, and runner normalizes `availableMsgs` before candidate planning/logging/queue counts.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, and `npm test -- --runInBand tests/promotion-policy.test.ts tests/promotion-flow-runner.test.ts` passed with 92 tests.
- Monitor verdict: dirty.

Iteration 3:
- Inventory: dirty - percentile aggregation converted string counters but did not clamp converted negative counters.
- Contracts: dirty - corrupted negative active-channel/intelligence counters could enter percentile buckets.
- Practical scenarios: dirty - negative historical counters could create impossible population thresholds and distort scoring/eligibility.
- Failure modes: dirty - a valid deployment with partial bad historical rows could still compute negative deleted-count or rate inputs.
- Algorithms: clean - valid percentile bucket computation unchanged.
- Fixes: Mongo aggregation numeric coercion now clamps converted values at zero before arithmetic and faceting.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, and `npm test -- --runInBand tests/percentile-engine.test.ts tests/classifier-and-scoring.test.ts tests/thompson-sampling.test.ts tests/channel-selection.test.ts` passed with 122 tests.
- Monitor verdict: dirty.

Iteration 4:
- Inventory: dirty - intelligence recency discounting was applied to success/deletion outcomes but not direct send-failure outcomes.
- Contracts: dirty - strategy-arm learning had inconsistent time decay depending on failure source.
- Practical scenarios: dirty - repeated Telegram send failures could over-weight old failure history compared with deletion failures.
- Failure modes: dirty - conversion-rate/message-strategy improvement could become more conservative than intended after historical send errors.
- Algorithms: dirty - failure outcome learning did not match the documented Thompson discount behavior.
- Fixes: `recordFailure()` now applies `applyDiscount()` before incrementing strategy failure counters.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, and `npm test -- --runInBand tests/channel-intelligence-service.test.ts tests/redis-modules.test.ts tests/conversion-attribution.test.ts tests/runtime.test.ts` passed with 172 tests.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - repeated empty-folder and debug/TODO/focused-test scans found no new source drift.
- Contracts: clean - source, test, and declaration type checks passed after all fixes.
- Practical scenarios: clean - available-message malformed inputs, negative percentile counters, and failure discount behavior are covered by focused tests.
- Failure modes: clean - full CI and prepublish suites passed Mongo, Redis, attribution, runtime, runner, queue, policy, scoring, selection, classifier, percentile, and bandit coverage.
- Algorithms: clean - full suites passed after all learning and percentile changes.
- Fixes: none.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm run typecheck:declarations`, `npm run test:ci` passed with 13 suites and 406 tests, `npm run prepublishOnly` passed with 13 suites and 406 tests, and post-build `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` produced 158 files, 76.3 kB packed, 396.0 kB unpacked.
- Monitor verdict: clean; this run reached clean validation after the fifth pass, with no new gaps found after the final source change.

Run: 2026-05-31 repeated five-iteration functionality/logic audit with queue field hygiene, strategy-key normalization, percentile numeric coercion, and Redis timestamp guards.

Iteration 1:
- Inventory: clean - source/test/docs inventory, package-root exports, hard-cut folder layout, empty-folder scan, and debug/TODO/focused-test scan remained consistent.
- Contracts: clean - public APIs remained reachable from `src/index.ts`; no stale compatibility paths or unexpected source folders found.
- Practical scenarios: clean - no drift found before deeper boundary review.
- Failure modes: clean - no empty source folders or focused/debug test markers.
- Algorithms: clean - not changed in this iteration.
- Fixes: none.
- Validation: `rg --files`, `find src -type d -empty`, debug/TODO/focused-test scan.
- Monitor verdict: clean.

Iteration 2:
- Inventory: dirty - `PromotionMessageQueue.readyForCheck()` could return unknown fields supplied by untyped `enqueue()` callers.
- Contracts: dirty - public queue output was wider than `PromotionQueuedMessage` and could leak caller-owned metadata.
- Practical scenarios: dirty - downstream consumers inspecting queue state could observe undocumented fields after malformed external enqueue.
- Failure modes: dirty - invalid queue metadata could leak across runner/account boundaries even though core queue fields were normalized.
- Algorithms: clean - queue timing, capacity, readiness, and invalid-strategy semantics unchanged.
- Fixes: queue normalization now returns only documented fields and drops unknown properties while still trimming IDs, indexes, timestamps, counts, and valid strategies.
- Validation: targeted runner/queue tests passed in `npm test -- --runInBand tests/promotion-flow-runner.test.ts ...`; strict type checks passed after follow-up typing cleanup.
- Monitor verdict: dirty.

Iteration 3:
- Inventory: dirty - strategy normalization was still incomplete for public direct bandit updates and persisted per-channel strategy map keys.
- Contracts: dirty - direct package consumers could call `bandit.update(' legacy ', 1)` and get a silent no-op; corrupted persisted keys like `' ai_contextual '` were ignored during per-channel sampling.
- Practical scenarios: dirty - restored or manually repaired intelligence data could lose strategy learning and fall back to global selection despite valid data.
- Failure modes: dirty - conversion-rate improvement and message-strategy learning could under-train or choose cold-start arms due to whitespace drift.
- Algorithms: clean - valid strategy reward math, Thompson sampling, and cold-start threshold semantics unchanged.
- Fixes: bandit updates now normalize strategy values, and `selectChannelStrategy()` normalizes persisted strategy keys before sampling.
- Validation: targeted `thompson-sampling.test.ts` passed with the runner/Redis/percentile batch; source and test type checks passed.
- Monitor verdict: dirty.

Iteration 4:
- Inventory: dirty - percentile aggregation relied on raw Mongo numeric fields and Redis tracker reads accepted future-dated corrupted records.
- Contracts: dirty - one string counter in active/intelligence Mongo rows could throw aggregation and force default percentile buckets; direct tracker reads could return future records.
- Practical scenarios: dirty - valid percentile rows could be discarded because of one corrupted document, and direct attribution consumers could see impossible future promoter state.
- Failure modes: dirty - eligibility/scoring could run with default population buckets, and tracker readers could over-trust corrupted future timestamps.
- Algorithms: clean - percentile bucket extraction, attribution decay, and valid tracker record semantics unchanged.
- Fixes: percentile aggregation now coerces active-channel and intelligence numeric fields before arithmetic; Redis tracker history and last-promoter reads now reject future timestamps.
- Validation: targeted `percentile-engine.test.ts` and `redis-modules.test.ts` passed with the runner/bandit batch; source/test/declaration type checks passed.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - repeated empty-folder and debug/TODO/focused-test scans found no new source drift.
- Contracts: clean - source, test, and declaration type checks passed after all fixes.
- Practical scenarios: clean - queue, strategy, percentile, and Redis timestamp scenarios are covered by focused tests.
- Failure modes: clean - full CI and prepublish suites passed Mongo, Redis, attribution, runtime, runner, queue, policy, scoring, selection, classifier, percentile, and bandit coverage.
- Algorithms: clean - full suites passed after all boundary and coercion changes.
- Fixes: none.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm run typecheck:declarations`, `npm test -- --runInBand tests/promotion-flow-runner.test.ts tests/thompson-sampling.test.ts tests/redis-modules.test.ts tests/percentile-engine.test.ts` passed with 169 tests, `npm run test:ci` passed with 13 suites and 404 tests, `npm run prepublishOnly` passed with 13 suites and 404 tests, and post-build `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` produced 158 files, 76.0 kB packed, 394.8 kB unpacked.
- Monitor verdict: clean; this run reached clean validation after the fifth pass, with no new gaps found after the final source change.

Run: 2026-05-31 repeated five-iteration functionality/logic audit with public API normalization and feature-specific Redis contracts.

Iteration 1:
- Inventory: clean - source/test/docs inventory, root export shape, package export shape, empty-folder scan, and debug/TODO scan matched the hard-cut common helper structure.
- Contracts: clean - package still exposes only the root npm surface and strict source/test type checks passed.
- Practical scenarios: clean - no stale compatibility paths or file ownership drift found.
- Failure modes: clean - no empty source folders or focused/debug test markers.
- Algorithms: clean - not changed in this iteration.
- Fixes: none.
- Validation: `rg --files`, `find src -type d -empty`, debug/TODO scan, `npm run typecheck`, `npm run typecheck:tests`.
- Monitor verdict: clean.

Iteration 2:
- Inventory: dirty - `PromotionMessageQueue.enqueue()` accepted direct malformed objects too narrowly and could leak invalid `strategy` properties.
- Contracts: dirty - direct JavaScript callers could pass `null` or an invalid strategy string into the public queue API.
- Practical scenarios: dirty - invalid strategy values could reappear from `readyForCheck()` even though queue normalization intended to keep only valid strategies.
- Failure modes: dirty - downstream queue consumers could observe impossible strategy values.
- Algorithms: clean - queue timing and capacity semantics unchanged.
- Fixes: queue normalization now rejects non-object entries, normalizes required fields through bracket-safe access, and strips invalid strategies before storing items.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- promotion-flow-runner.test.ts --runInBand` passed with 58 tests.
- Monitor verdict: dirty.

Iteration 3:
- Inventory: dirty - direct `selectPromotionChannels()` callers still received raw whitespace-padded channel IDs.
- Contracts: dirty - selected/proven/stale/untested outputs did not match the normalized IDs used internally for dedupe and intelligence lookup.
- Practical scenarios: dirty - consumers using the selection API outside the runner could send or persist padded channel IDs.
- Failure modes: dirty - public selection output could drift from runtime-normalized runner behavior.
- Algorithms: clean - selection ranking/splitting behavior unchanged.
- Fixes: selection now normalizes valid channel objects before categorization and output.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- channel-selection.test.ts classifier-and-scoring.test.ts thompson-sampling.test.ts promotion-policy.test.ts --runInBand` passed with 121 tests.
- Monitor verdict: dirty.

Iteration 4:
- Inventory: dirty - runtime Redis validation used one full tracker-capable shape for all Redis-backed features.
- Contracts: dirty - a lock-compatible Redis wrapper with `get`, `set`, and `exists` could not enable locks unless it also implemented tracker list/pipeline methods.
- Practical scenarios: dirty - deployments enabling only cross-account locks could silently get locks disabled with partial Redis wrappers.
- Failure modes: dirty - lock protection could be absent despite `enableLocks=true`.
- Algorithms: clean - Redis lock/tracker/percentile semantics unchanged.
- Fixes: runtime now validates Redis capabilities per feature: percentile cache needs `get/set`, locks need `get/set/exists`, attribution tracker needs `get/set/lrange/pipeline`.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, escalated `npm test -- runtime.test.ts redis-modules.test.ts conversion-attribution.test.ts channel-intelligence-service.test.ts --runInBand` passed with 169 tests.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - repeated empty-folder and debug/TODO scans found no source drift.
- Contracts: clean - source, test, and declaration type checks passed.
- Practical scenarios: clean - no new drift after queue, selection, and runtime Redis contract fixes.
- Failure modes: clean - full CI and prepublish suites passed Mongo, Redis, attribution, runtime, runner, queue, policy, scoring, selection, classifier, percentile, and bandit coverage.
- Algorithms: clean - full suites passed after normalization and runtime contract changes.
- Fixes: none.
- Validation: `find src -type d -empty`, debug/TODO scan, `npm run typecheck`, `npm run typecheck:tests`, `npm run typecheck:declarations`, escalated `npm run test:ci`, escalated `npm run prepublishOnly`, and `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` passed. Full suite result: 13 suites, 399 tests. Package dry-run produced 158 files, 75.7 kB packed, 393.9 kB unpacked.
- Monitor verdict: clean; repeated full-suite coverage through both `test:ci` and `prepublishOnly` provided a clean convergence confirmation after the last source change.

Run: 2026-05-31 repeated five-iteration functionality/logic audit with runner boundary and strategy-normalization fixes.

Iteration 1:
- Inventory: clean - source inventory, package-root export shape, folder barrels, empty-folder scan, and debug/TODO scan remained consistent with the hard-cut `src/channel-message-promotions` structure.
- Contracts: clean - public exports stayed package-root reachable and strict source/test/declaration type gates passed.
- Practical scenarios: clean - no stale compatibility paths or package-boundary drift found.
- Failure modes: clean - no empty source folders or debug/test focus markers.
- Algorithms: clean - not changed in this iteration.
- Fixes: none.
- Validation: `rg --files`, `find src -type d -empty`, debug/TODO scan, `npm run typecheck`, `npm run typecheck:tests`, `npm run typecheck:declarations`.
- Monitor verdict: clean.

Iteration 2:
- Inventory: dirty - runner accepted raw loaded/direct channel rows after selection normalization.
- Contracts: dirty - direct `processChannel()` calls from untyped consumers could pass malformed channel objects.
- Practical scenarios: dirty - whitespace-padded channel IDs could reach adapter lookups/sends and malformed rows could reach flow entry points.
- Failure modes: dirty - malformed direct channel calls could throw instead of being skipped with a visible log.
- Algorithms: clean - selection algorithm unchanged; runner boundary now carries normalized IDs.
- Fixes: runner now normalizes loaded channel rows, trims channel IDs before adapter/account flow, and skips malformed direct channel calls.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- promotion-flow-runner.test.ts --runInBand` passed with 58 tests.
- Monitor verdict: dirty.

Iteration 3:
- Inventory: dirty - public message-index policy APIs did not trim direct inputs.
- Contracts: dirty - package consumers calling `messageIndexToStrategy()` or `evaluateDeletionPolicy()` with whitespace-padded indexes got legacy/unknown behavior.
- Practical scenarios: dirty - direct deletion-policy callers could misclassify `' custom '`, `' followUp '`, or `' 0 '`.
- Failure modes: dirty - deletion actions and bandit strategy attribution could drift for padded message indexes.
- Algorithms: clean - policy semantics unchanged after normalization.
- Fixes: message-index policy now trims before strategy and deletion-action mapping.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- promotion-policy.test.ts channel-selection.test.ts classifier-and-scoring.test.ts thompson-sampling.test.ts --runInBand` passed with 121 tests.
- Monitor verdict: dirty.

Iteration 4:
- Inventory: dirty - strategy normalization was inconsistent across public policy, queue, runner, bandit, and intelligence boundaries.
- Contracts: dirty - direct package consumers or restored state could pass whitespace-padded strategies.
- Practical scenarios: dirty - values like `' ai_contextual '` could be ignored or mapped to legacy depending on entry point.
- Failure modes: dirty - persistence and learning counters could train the wrong arm for padded strategy values.
- Algorithms: clean - valid strategy semantics unchanged; only boundary normalization changed.
- Fixes: strategies are now trimmed in policy input, externally owned queue data, runner ready-message normalization, bandit constructor/deserialize, and intelligence Mongo writes.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, non-Mongo affected tests passed with 126 tests, escalated `channel-intelligence-service.test.ts` passed with 92 tests, escalated `conversion-attribution.test.ts` passed with 25 tests, and `redis-modules.test.ts` passed with 40 tests. A combined Mongo batch hit memory-server startup contention before tests executed.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - repeated empty-folder and debug/TODO scans found no new source drift.
- Contracts: clean - source, test, and declaration type checks passed.
- Practical scenarios: clean - no new drift after runner boundary, message-index, and strategy normalization fixes.
- Failure modes: clean - full CI and prepublish suites passed Mongo, Redis, attribution, runner, queue, runtime, policy, scoring, selection, classifier, percentile, and bandit coverage.
- Algorithms: clean - full suites passed after the normalization changes.
- Fixes: none.
- Validation: `find src -type d -empty`, debug/TODO scan, `npm run typecheck`, `npm run typecheck:tests`, `npm run typecheck:declarations`, escalated `npm run test:ci`, escalated `npm run prepublishOnly`, and `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` passed. Full suite result: 13 suites, 398 tests. Package dry-run produced 158 files, 75.4 kB packed, 391.3 kB unpacked.
- Monitor verdict: clean; repeated full-suite coverage through both `test:ci` and `prepublishOnly` provided a clean convergence confirmation after the last source change.

Run: 2026-05-31 repeated five-iteration functionality/logic audit with queued-strategy, scoring timestamp, and Mongo outcome-counter fixes.

Iteration 1:
- Inventory: clean - package-root exports, folder barrels, source layout, stale-path scan, and empty-folder scan remained consistent with the hard-cut `src/channel-message-promotions` structure.
- Contracts: clean - public exports stayed package-root reachable and no old compatibility paths were referenced.
- Practical scenarios: clean - no package-boundary, source-ownership, or file-layout drift found.
- Failure modes: clean - no empty source folders, stale promotion imports, or debug/TODO code outside prior audit notes.
- Algorithms: clean - not changed in this iteration.
- Fixes: none.
- Validation: stale-path `rg` scan, `find src -type d -empty`, `npm run typecheck`.
- Monitor verdict: clean.

Iteration 2:
- Inventory: dirty - queued message state did not preserve the selected bandit strategy for later deletion accounting.
- Contracts: clean - queue and runner public contracts stayed stable; optional `strategy` is normalized for externally owned queues.
- Practical scenarios: dirty - a custom-slot send selected by `question_doubt`, `markov_chain`, or `curiosity_gap` could later be penalized as `natural_template` when deleted.
- Failure modes: dirty - deletion accounting could train the wrong strategy after successful custom-slot sends.
- Algorithms: dirty - deletion bandit penalties now use the queued selected strategy when available.
- Fixes: queued messages preserve normalized strategy, runner deletion accounting resolves the same strategy used at send time, and queue normalization accepts valid strategy values only.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- promotion-flow-runner.test.ts runtime.test.ts promotion-policy.test.ts --runInBand` passed with 100 tests.
- Monitor verdict: dirty.

Iteration 3:
- Inventory: dirty - expected-value scoring treated future-dated online/view timestamps as fresh.
- Contracts: clean - scoring public API stayed unchanged.
- Practical scenarios: dirty - corrupted clocks or future-dated persisted timestamps could create freshness bonuses.
- Failure modes: dirty - malformed future telemetry could increase channel score instead of degrading to stale.
- Algorithms: dirty - online and view freshness now use safe age calculation that treats invalid or future timestamps as stale.
- Fixes: expected-value scoring now shares `now` per computation and uses `safeAgeMs()` for online/view recency; added future-timestamp regression coverage.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- classifier-and-scoring.test.ts channel-selection.test.ts thompson-sampling.test.ts promotion-policy.test.ts promotion-flow-runner.test.ts --runInBand` passed with 177 tests.
- Monitor verdict: dirty.

Iteration 4:
- Inventory: dirty - success and follow-up outcome writes did not repair all Mongo numeric leaves before `$inc`.
- Contracts: clean - intelligence service public API stayed unchanged.
- Practical scenarios: dirty - existing Mongo intelligence documents with corrupted `totalSendsToChannel`, `followupTotal`, or `followupSuccessCount` leaves could break outcome writes.
- Failure modes: dirty - success or follow-up deletion writes could fail on legacy/corrupted documents.
- Algorithms: clean - outcome semantics unchanged; persistence is more defensive.
- Fixes: success/deletion paths now repair affected numeric fields before `$inc`; added regression coverage for corrupted total-send and follow-up counters.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, escalated `npm test -- channel-intelligence-service.test.ts percentile-engine.test.ts redis-modules.test.ts conversion-attribution.test.ts runtime.test.ts --runInBand` passed with 198 tests after sandbox Mongo bind failure.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - repeated stale-path scan and empty-folder scan found no source drift.
- Contracts: clean - source, test, and declaration type checks passed.
- Practical scenarios: clean - no new drift after queued-strategy, scoring timestamp, and Mongo counter fixes.
- Failure modes: clean - full suite passed Mongo, Redis, runner, attribution, queue, policy, and runtime regressions.
- Algorithms: clean - full suite passed scoring, selection, percentile, classifier, and bandit regressions.
- Fixes: none.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm run typecheck:declarations`, escalated `npm run test:ci`, escalated `npm run prepublishOnly`, and `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` passed. Full suite result: 13 suites, 395 tests.
- Monitor verdict: clean.

Convergence confirmation:
- Inventory: clean - repeated stale-path scan and `find src -type d -empty` found no new work.
- Contracts: clean - `npm run typecheck`, `npm run typecheck:tests`, and `npm run typecheck:declarations` passed again.
- Practical scenarios: clean - repeated full CI suite found no new drift.
- Failure modes: clean - `npm run prepublishOnly` passed again with 13 suites and 395 tests.
- Algorithms: clean - full suite passed again with 13 suites and 395 tests.
- Fixes: no behavioral fixes; queue strategy normalization was cleaned up to avoid duplicate normalization calls, then validation was rerun.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- promotion-flow-runner.test.ts --runInBand`, escalated `npm run test:ci`, escalated `npm run prepublishOnly`, and `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` passed; package dry-run produced 158 files, 74.8 kB packed, 387.0 kB unpacked.
- Monitor verdict: clean; stop rule satisfied after two consecutive clean passes.

Run: 2026-05-31 repeated five-iteration functionality/logic audit with hidden-gap fixes.

Iteration 1:
- Inventory: clean - package-root exports, folder barrels, source layout, stale-path scan, TODO/debug scan, and empty-folder scan remained consistent with the hard-cut `src/channel-message-promotions` structure.
- Contracts: clean - public exports remained package-root reachable and no old compatibility paths were referenced.
- Practical scenarios: clean - no package-boundary or file ownership drift found.
- Failure modes: clean - no empty source folders or stale source imports.
- Algorithms: clean - not changed in this iteration.
- Fixes: none.
- Validation: stale-path `rg` scan, `find src -type d -empty`, `npm run typecheck`.
- Monitor verdict: clean.

Iteration 2:
- Inventory: dirty - runner lifecycle had an adapter sleep failure gap.
- Contracts: dirty - `sleep()` is adapter-provided and can throw in custom test/live integrations.
- Practical scenarios: dirty - a custom timer backend failure after send or between loop cycles could reject a direct cycle or tear down a started loop.
- Failure modes: dirty - sleep failures were not isolated like logging and hooks.
- Algorithms: clean - selection/scoring behavior unchanged.
- Fixes: runner sleep now logs and continues when adapter sleep throws; added direct-cycle regression coverage.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- promotion-flow-runner.test.ts runtime.test.ts --runInBand` passed with 65 tests.
- Monitor verdict: dirty.

Iteration 3:
- Inventory: dirty - success accounting had a custom-slot strategy attribution gap.
- Contracts: clean - message candidate contracts stayed stable.
- Practical scenarios: dirty - bandit strategies such as `markov_chain`, `question_doubt`, and `curiosity_gap` send through the `custom` slot but must keep independent counters.
- Failure modes: dirty - successful sends could be credited to `natural_template` instead of the selected bandit strategy.
- Algorithms: dirty - success accounting now uses the selected candidate strategy, matching failure accounting.
- Fixes: runner success recording receives the candidate and resolves strategy from it; added a `markov_chain` custom-slot success regression.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- channel-selection.test.ts promotion-policy.test.ts classifier-and-scoring.test.ts thompson-sampling.test.ts promotion-flow-runner.test.ts --runInBand` passed with 175 tests.
- Monitor verdict: dirty.

Iteration 4:
- Inventory: dirty - conversion persistence had a corrupted-counter `$inc` gap.
- Contracts: clean - public attribution and intelligence APIs stayed unchanged.
- Practical scenarios: dirty - existing Mongo intelligence documents with corrupted `conversions` or `paidConversions` leaves could break attribution writes.
- Failure modes: dirty - conversion `$inc` did not repair numeric leaves before writing.
- Algorithms: clean - attribution weighting semantics unchanged.
- Fixes: conversion and paid-conversion writes repair numeric leaves before `$inc`; added free and paid conversion counter repair regressions.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, escalated `npm test -- channel-intelligence-service.test.ts percentile-engine.test.ts redis-modules.test.ts conversion-attribution.test.ts public-api.test.ts --runInBand` passed with 191 tests after sandbox Mongo bind failure.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - static scans found no stale promotion imports and no empty source folders.
- Contracts: clean - source, test, and declaration type checks passed.
- Practical scenarios: clean - no new drift after runner, strategy-accounting, and conversion-persistence fixes.
- Failure modes: clean - full suite passed Mongo, Redis, runner, attribution, queue, and policy regressions.
- Algorithms: clean - full suite passed scoring, selection, percentile, classifier, and bandit regressions.
- Fixes: none.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm run typecheck:declarations`, escalated `npm run test:ci`, escalated `npm run prepublishOnly`, `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` passed. Full suite result: 13 suites, 391 tests.
- Monitor verdict: clean.

Convergence confirmation:
- Inventory: clean - repeated stale-path scan and `find src -type d -empty` found no new work.
- Contracts: clean - `npm run typecheck` and `npm run typecheck:tests` passed again.
- Practical scenarios: clean - repeated full CI suite found no new drift.
- Failure modes: clean - `npm run prepublishOnly` passed again.
- Algorithms: clean - full suite passed again with 13 suites and 391 tests.
- Fixes: none.
- Validation: escalated `npm run test:ci`, escalated `npm run prepublishOnly`, and `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` passed.
- Monitor verdict: clean; stop rule satisfied after two consecutive clean passes.

Run: 2026-05-31 five-iteration functionality/hidden-issue audit plus convergence confirmation.

Iteration 1:
- Inventory: clean - package-root exports, folder barrels, source layout, stale-path scan, and empty-folder scan remained consistent with the hard-cut `src/channel-message-promotions` structure.
- Contracts: clean - public package surface stayed reachable through `src/index.ts` and no old compatibility paths were referenced.
- Practical scenarios: clean - no new package-boundary drift found.
- Failure modes: clean - no empty source folders or stale source imports.
- Algorithms: clean - not changed in this iteration.
- Fixes: none.
- Validation: stale-path `rg` scan, `find src -type d -empty`, `npm run typecheck`.
- Monitor verdict: clean.

Iteration 2:
- Inventory: dirty - runner lifecycle gates had a malformed-adapter gap.
- Contracts: dirty - `isActive()` and `shouldContinue()` are typed as boolean, but JavaScript callers or adapter bugs could return truthy non-booleans.
- Practical scenarios: dirty - values like `'false'` or `'true'` could continue promotion sends.
- Failure modes: dirty - malformed active/continue return values could allow live sends after the adapter should have stopped.
- Algorithms: clean - selection/scoring behavior unchanged.
- Fixes: runner gates now require exact `true`; added regression coverage for malformed active and continuation return values.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- promotion-flow-runner.test.ts runtime.test.ts --runInBand` passed.
- Monitor verdict: dirty.

Iteration 3:
- Inventory: clean - policy, selection, scoring, classifier, percentile, and bandit files mapped to checklist ownership.
- Contracts: clean - malformed policy/options and injected randomness paths were already covered.
- Practical scenarios: clean - no new scenario drift in selection, eligibility, follow-up, scoring, or bandit learning.
- Failure modes: clean - malformed numeric inputs remained bounded.
- Algorithms: clean - targeted algorithm suites passed without changes.
- Fixes: none.
- Validation: `npm test -- channel-selection.test.ts promotion-policy.test.ts classifier-and-scoring.test.ts thompson-sampling.test.ts --runInBand` passed.
- Monitor verdict: clean.

Iteration 4:
- Inventory: dirty - Redis tracker pipeline write path had hidden command-error handling drift.
- Contracts: dirty - compatible ioredis pipeline `exec()` can resolve `[err, result]` tuples instead of throwing.
- Practical scenarios: dirty - command-level pipeline errors could look successful to attribution history writes.
- Failure modes: dirty - Redis write failure visibility was incomplete.
- Algorithms: clean - attribution scoring semantics unchanged.
- Fixes: Redis promotion tracker now detects command-level pipeline exec errors and throws a clear error; added regression coverage.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm test -- channel-intelligence-service.test.ts percentile-engine.test.ts redis-modules.test.ts conversion-attribution.test.ts public-api.test.ts --runInBand` passed.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - static scans found no stale promotion imports and no empty source folders.
- Contracts: clean - source, tests, and declaration type checks passed.
- Practical scenarios: clean - no new practical scenario drift after the Redis and runner fixes.
- Failure modes: clean - full suite passed all Mongo, Redis, runner, attribution, queue, and policy regressions.
- Algorithms: clean - full suite passed scoring, selection, percentile, classifier, and bandit regressions.
- Fixes: none.
- Validation: `npm run typecheck`, `npm run typecheck:tests`, `npm run typecheck:declarations`, `npm run test:ci`, `npm run prepublishOnly`, `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` passed. Full suite result: 13 suites, 387 tests.
- Monitor verdict: clean.

Convergence confirmation:
- Inventory: clean - repeated stale-path scan and `find src -type d -empty` found no new work.
- Contracts: clean - `npm run typecheck` and `npm run typecheck:tests` passed again.
- Practical scenarios: clean - repeated full CI suite found no new drift.
- Failure modes: clean - `npm run prepublishOnly` passed again.
- Algorithms: clean - full suite passed again with 13 suites and 387 tests.
- Fixes: none.
- Validation: `npm run test:ci`, `npm run prepublishOnly`, and `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run` passed.
- Monitor verdict: clean; stop rule satisfied after two consecutive clean passes.

Run: 2026-05-31 deeper functionality/hidden-gap audit.

Iteration 1:
- Inventory: clean - production files remain under `src/channel-message-promotions` plus shared structural types under `src/types`.
- Contracts: clean - root exports and folder barrels expose the intended public package surface only.
- Practical scenarios: clean - no new package-boundary scenario drift.
- Failure modes: clean - no stale old-path imports, no empty source folders.
- Algorithms: clean - not in scope for this pass.
- Fixes: none.
- Validation: `npm run typecheck`.
- Monitor verdict: clean.

Iteration 2:
- Inventory: dirty - runner flow had an optimization feedback gap.
- Contracts: clean - runner and runtime construction contracts still fail fast or degrade safely.
- Practical scenarios: dirty - adapter send failures with a known candidate strategy did not penalize the bandit arm.
- Failure modes: dirty - repeated send failures could leave the optimization loop overconfident in the failed message arm.
- Algorithms: dirty - bandit learning now records reward `0` on failed send candidates.
- Fixes: `PromotionFlowRunner.recordFailure()` updates the bandit with reward `0`; added a runner regression test.
- Validation: `npm run typecheck`; `npm run typecheck:tests`; `npm test -- promotion-flow-runner.test.ts runtime.test.ts --runInBand`.
- Monitor verdict: dirty.

Iteration 3:
- Inventory: dirty - message strategy state handling had a poisoned-counter gap.
- Contracts: clean - public bandit methods remain tolerant of malformed callers.
- Practical scenarios: dirty - corrupted in-memory arm counters could survive into the next update.
- Failure modes: clean - selection and serialization already degraded safely.
- Algorithms: dirty - `DiscountedThompsonSampling.update()` now normalizes arm counters before reward application.
- Fixes: sanitized success/failure/totalPull counters before discount and increment; added regression coverage.
- Validation: `npm run typecheck`; `npm run typecheck:tests`; `npm test -- channel-selection.test.ts promotion-policy.test.ts classifier-and-scoring.test.ts thompson-sampling.test.ts promotion-flow-runner.test.ts --runInBand`.
- Monitor verdict: dirty.

Iteration 4:
- Inventory: dirty - Mongo outcome writes had a numeric-leaf repair gap.
- Contracts: clean - Redis, attribution, and public type contracts stayed stable.
- Practical scenarios: dirty - existing Mongo intelligence docs with string, `NaN`, or negative counter leaves could fail later `$inc` writes.
- Failure modes: dirty - corrupted strategy, deletion, or error counter leaves could break outcome persistence in real Mongo.
- Algorithms: clean - scoring and attribution math unchanged.
- Fixes: `ensureWritableSubdocuments()` repairs numeric leaves before outcome writes; added Mongo-backed regression coverage.
- Validation: `npm run typecheck`; `npm run typecheck:tests`; `npm test -- channel-intelligence-service.test.ts percentile-engine.test.ts redis-modules.test.ts conversion-attribution.test.ts public-api.test.ts --runInBand`.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - no stale imports and no empty source folders.
- Contracts: clean - source, test, declaration, prepublish, and package dry-run gates passed.
- Practical scenarios: clean - no new drift found after the iteration 2-4 fixes.
- Failure modes: clean - full CI passed.
- Algorithms: clean - no additional scoring, policy, strategy, or attribution drift found.
- Fixes: none.
- Validation: `npm run typecheck`; `npm run typecheck:tests`; `npm run typecheck:declarations`; `npm run test:ci`; `npm run prepublishOnly`; `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run`.
- Monitor verdict: clean.

Convergence confirmation:
- Inventory: clean - repeated stale-import and empty-folder scans stayed clean.
- Contracts: clean - strict source/test checks passed again.
- Practical scenarios: clean - no new checklist items or code changes required.
- Failure modes: clean - full CI and prepublish passed again.
- Algorithms: clean - no new drift found.
- Fixes: none.
- Validation: `npm run typecheck`; `npm run typecheck:tests`; `npm run test:ci`; `npm run prepublishOnly`; `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run`.
- Monitor verdict: clean. Two consecutive clean passes reached after the iteration 2-4 fixes.

Iteration 1:
- Inventory: clean - production files are under `src/channel-message-promotions` plus shared structural types under `src/types`.
- Contracts: clean - root exports are package-root reachable through `src/index.ts`.
- Practical scenarios: clean - no code changes required in this pass.
- Failure modes: clean - runtime ownership and singleton replacement behavior already covered.
- Algorithms: clean - no drift found in this pass.
- Fixes: none.
- Validation: covered by later full-gate runs.
- Monitor verdict: clean.

Iteration 2:
- Inventory: clean - orchestrator and queue files mapped to checklist ownership.
- Contracts: clean - runner optional dependencies degrade instead of breaking send/delete/follow-up flow.
- Practical scenarios: clean - queue, send, follow-up, deletion, and adapter failure cases covered.
- Failure modes: clean - targeted runner/runtime suite passed.
- Algorithms: clean - no scoring drift found in this pass.
- Fixes: none in this iteration.
- Validation: `npm test -- promotion-flow-runner.test.ts runtime.test.ts --runInBand`; `npm run typecheck:tests`.
- Monitor verdict: clean.

Iteration 3:
- Inventory: clean - policy, selection, scoring, classifier, and bandit files mapped to checklist ownership.
- Contracts: clean - malformed public policy and algorithm inputs are normalized or rejected safely.
- Practical scenarios: clean - conversion-rate, deletion, saturation, strategy, and selection edge cases covered.
- Failure modes: clean - no retry or accounting drift found.
- Algorithms: clean - targeted algorithm suite passed.
- Fixes: none in this iteration.
- Validation: `npm test -- channel-selection.test.ts promotion-policy.test.ts classifier-and-scoring.test.ts thompson-sampling.test.ts --runInBand`; `npm run typecheck`.
- Monitor verdict: clean.

Iteration 4:
- Inventory: dirty - attribution type contract had a realistic caller drift.
- Contracts: dirty - Telegram common-chat IDs may arrive as `number` or `bigint`, but attribution only accepted string IDs.
- Practical scenarios: dirty - added numeric/bigint common-chat ID scenario.
- Failure modes: clean - Redis and persistence degradation paths remained isolated.
- Algorithms: clean - attribution decay and paid-conversion guard unchanged.
- Fixes: added public `CommonChatId` type and numeric/bigint normalization before Redis lookup.
- Validation: `npm run typecheck`; `npm run typecheck:tests`; `npm test -- conversion-attribution.test.ts redis-modules.test.ts channel-intelligence-service.test.ts percentile-engine.test.ts public-api.test.ts --runInBand`.
- Monitor verdict: dirty.

Iteration 5:
- Inventory: clean - no stale imports, no empty source folders, and no stale package paths found.
- Contracts: clean - package root and declaration surfaces validate.
- Practical scenarios: clean - no new drift after the attribution fix.
- Failure modes: clean - full CI passed.
- Algorithms: clean - no new scoring, selection, policy, or attribution drift found.
- Fixes: none.
- Validation: `npm run typecheck`; `npm run typecheck:tests`; `npm run typecheck:declarations`; `npm run test:ci`; `npm run prepublishOnly`; `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run`; `find src -type d -empty`.
- Monitor verdict: clean.

Convergence confirmation:
- Inventory: clean - repeated static scans found no stale imports, TODO/debug console usage, or empty source folders.
- Contracts: clean - strict source, test, and declaration type checks passed again.
- Practical scenarios: clean - no new checklist additions or code changes required.
- Failure modes: clean - full CI and prepublish passed again.
- Algorithms: clean - no new logic drift found.
- Fixes: none.
- Validation: `npm run typecheck`; `npm run typecheck:tests`; `npm run typecheck:declarations`; `npm run test:ci`; `npm run prepublishOnly`; `npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run`.
- Monitor verdict: clean. Two consecutive clean passes reached after the iteration 4 fix.
