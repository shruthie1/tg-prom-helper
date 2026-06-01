# Channel Message Promotions Functional Audit Checklist

Use this checklist for every audit iteration over `src/channel-message-promotions` and shared `src/types`.

The repeated audit loop is supervised by `docs/channel-message-promotions-audit-monitor.md`. Do not stop after an arbitrary number of passes; stop only after the monitor records two consecutive clean iterations with no practical scenario drift and no new gaps.

## Iteration Flow

1. Map each file to its runtime responsibility and public surface.
2. Review functional correctness for happy path, negative path, and retry/degradation path.
3. Check type contracts, optional properties, nullability, singleton lifecycle, and exported API shape.
4. Check state mutation, counters, queues, timers, Redis keys, Mongo updates, and attribution side effects.
5. Add or update focused tests for every production-relevant gap.
6. Run strict type checks and targeted/full tests before marking the iteration complete.

## File Checklist

| Area | Files | Functional checks |
| --- | --- | --- |
| Public exports | `src/index.ts`, `src/channel-message-promotions/index.ts`, folder `index.ts` files | Exports are intentional, hard-cut compatible, and do not expose stale paths. |
| Types | `src/types/*.ts`, `policy.types.ts`, `channel-intelligence.types.ts`, `promotion-flow.types.ts` | Optional fields obey `exactOptionalPropertyTypes`; public contracts match both single-account and multi-account callers. |
| Runtime | `runtime/promotion-runtime.ts` | Singleton replacement/reset works; disabled Redis features stay disabled; multiple account contexts remain isolated by mobile/clientId. |
| Orchestrator | `orchestrator/promotion-flow-runner.ts`, `promotion-message-queue.ts`, `promotion-runner-supervisor.ts` | Selection, eligibility, candidate attempts, accounting, queue checks, deletion, follow-up, stop/start, retries, health snapshots, supervision, and hook failures are safe. |
| Policies | `policy/*.ts` | Batch, delay, deletion, eligibility, follow-up, and message strategy policies preserve premium guards, fail-streak behavior, practical fallback behavior, and internal-only sanitization helpers. |
| Selection | `selection/channel-selection.ts` | Proven/untested/stale/cooldown splits are deterministic under injected randomness and never overrun batch capacity. |
| Intelligence | `channel-intelligence/*.ts` | Mongo updates are idempotent; stage transitions and expected value recomputation remain bounded and degradation-safe. |
| Percentiles | `channel-intelligence/percentile-engine.ts` | Redis cache read/write failures degrade to computation/local cache; empty facets return safe defaults. |
| Message strategy | `message-strategy/*.ts` | Bandit selection handles cold start, corrupted state, unknown strategies, and serialization safely. |
| Redis | `redis/*.ts` | TTLs and key formats are stable; corrupted Redis data is ignored without throwing. |
| Attribution | `attribution/conversion-attribution.ts` | Common chats are deduped; attribution window, decay, paid conversion, and tracker failures are safe. |
| Scoring | `scoring/expected-value.ts` | Inputs are clamped; missing percentiles/trends do not produce NaN or out-of-range scores. |
| Config | `config/feature-flags.ts` | Defaults are conservative and env parsing is explicit. |

## Hardening Checks Added

- Selection and percentile rank inputs clamp malformed values into safe bounds.
- Runner `start()` tolerates transient cycle failures and active-state check failures without killing the long-running loop.
- Adapter logging and observer hooks cannot change promotion control flow.
- Classification ignores malformed pull counters and treats invalid cached expected value as neutral.
- Expected value scoring sanitizes malformed strategy arms, follow-up metrics, deletion buckets, trend data, error counters, conversion counts, and saturation rates.
- Root package exports cover consumer-facing runtime, runner, policy, Redis, attribution, scoring, and type contracts.
- Attribution rejects future-dated or invalid promoter timestamps before applying recency decay.
- Policy counters, fail streaks, day counts, and injected randomness are normalized before branch decisions.
- Message queues normalize invalid capacity and treat invalid/future queued timestamps as ready for retry rather than blocking forever.
- Invalid Telegram message IDs are recorded as send success but are not queued for deletion/follow-up checks.
- Redis locks and trackers ignore blank channel/mobile/client identifiers and trim valid identifiers before writing keys.
- Intelligence write APIs clamp profile/classification confidence, sanitize saturation and EWMA counters, and classify malformed deletion survival as automod.
- Selection normalizes malformed batch size, stale/cooldown timestamps, explore percentages, weights, and injected randomness before splitting candidates.
- Message-strategy bandits sanitize malformed config, rewards, deserialized state, and per-channel pull counters before selection or update.
- Percentile cache reads validate parsed JSON shape and bucket values before trusting Redis, then degrade to recomputation/local cache.
- Account contexts trim mobile/client identifiers, reject blank identity, and ignore blank channel IDs at the account boundary.
- Runner timing options, batch targets, follow-up delays, and follow-up caps are normalized before timers, sleeps, or selection.
- Follow-up policy treats malformed premium/cap counters conservatively instead of scheduling accidental follow-ups.
- Existing-message queue checks complete when follow-up stats fail; the message is not retried forever because of scheduler metadata outage.
- Deletion accounting clamps malformed/future queued timestamps before writing survival metrics.
- Policy guards ignore malformed/future previous-failure timestamps and sanitize available-message counts/IDs before branch decisions.
- Attribution trims and dedupes common chat IDs before Redis lookup and conversion writes.
- Redis key writers/readers ignore blank or non-string identifiers instead of throwing.
- View engagement records zero-view checks as valid low-engagement samples while still rejecting invalid participant counts.
- Failure accounting normalizes malformed error types before categorization and cooldown decisions.
- Runner per-channel `isActive`, `shouldContinue`, and adapter recent-queue probes degrade with logs instead of tearing down the cycle.
- Message policy ignores invalid bandit strategy values from JavaScript callers before building candidates.
- Bandit state restore ignores non-array serialized data.
- Classifier, profile, and classification update APIs normalize malformed runtime labels/objects before writing Mongo state.
- Internal sanitization helpers remain private to the package implementation and are not exposed from the root API.
- Selection now skips blank or duplicate channel IDs and matches intelligence docs by normalized IDs.
- Direct intelligence service reads/writes normalize channel IDs, dedupe batch lookups, and clamp top-channel limits.
- Externally owned message queues reject invalid channel/message entries and normalize queued timestamps/counts.
- Bandit construction dedupes valid strategies and falls back to `legacy` when untyped callers provide no valid arms.
- Attribution isolates per-channel tracker and persistence failures so valid attribution remains visible.
- Redis tracker reads normalize corrupted-but-valid cached identifiers before returning history or last-promoter records.
- Runner normalizes malformed adapter stats and message-check results before policy branching.
- Runner scoring-mode delay falls back to configured loop delay if post-send stats loading fails.
- Eligibility policy treats throwing or malformed percentile providers as neutral percentile ranks.
- Selection ranks whitespace-padded proven channels by normalized IDs and ignores malformed intelligence documents.
- Expected-value scoring tolerates missing nested document state and bad percentile rank callbacks without throwing.
- Runner normalizes malformed adapter send results into terminal failures with schema-safe message indexes.
- Intelligence success/deletion/failure writes normalize invalid strategy names to `legacy` before writing Mongo counters.
- Message queue normalizes malformed queued message indexes to `0`.
- Per-channel strategy selection ignores malformed stored strategy maps and falls back to the global bandit.
- Feature flag parsing treats malformed env objects as all-disabled while preserving exact `'true'` enablement semantics.
- Corrupted persisted intelligence subdocuments are repaired before nested Mongo `$inc` outcome writes.
- Percentile aggregation facets with malformed row shapes are treated as empty buckets.
- Runner planning degrades through transient stats and intelligence batch outages instead of aborting sendable channels.
- Channel selection ignores malformed channel rows and malformed option objects from untyped callers.
- Conversion attribution records paid conversions only when `isPaid === true`.
- Runtime creation and account-context creation fail fast with clear errors for malformed top-level options.
- Runner construction fails fast for malformed required adapter/account dependencies and ignores malformed optional queue/bandit dependencies.
- Public policy functions tolerate malformed top-level input objects and require exact boolean flags for hard-stop/scoring/follow-up behavior.
- Percentile refresh degrades to safe default buckets when active-channel aggregation fails or returns malformed results.
- Redis lock/tracker public constructors and init paths fail fast for malformed clients while tolerating malformed singleton options.
- Bandit public methods tolerate malformed constructor config, serialized entries, and poisoned in-memory arm storage.
- Attribution public construction fails fast for missing collaborator methods and singleton init tolerates malformed options.
- Intelligence and percentile public constructors fail fast for malformed Mongo/Redis dependencies and singleton init tolerates malformed options.
- Redis tracker read/write paths handle malformed list and pipeline return shapes explicitly.
- Runtime creation clears stale optional singletons even on first creation when corresponding features are disabled.
- Channel selection caps final selection to `batchTarget` even when explore and re-eval ratio options overlap.
- Runner queue checks normalize externally owned queue output while preserving original queue item identity for removal.
- Runner queue cleanup logs and continues when an externally owned queue throws during removal.
- Follow-up delay calculation normalizes malformed base delays as well as malformed jitter ranges.
- Channel intelligence read APIs treat malformed cursor objects, non-array `toArray()` results, and malformed rows as safe empty/filtered reads.
- Direct `runOnce()` calls degrade on transient channel-load failure instead of throwing out of the runner.
- New cursor and queue normalization helpers remain private implementation details and are covered by public API guards.
- Background queue-check interval errors use the runner's normalized error formatter so object-shaped failures remain searchable in logs.
- Follow-up execution errors use the same normalized error formatter so non-`Error` adapter failures are not logged as `[object Object]`.
- Runner isolates optional bandit selection/update failures so a broken optimization dependency cannot break send, queue, deletion, or accounting flow.
- Standalone expected-value scoring handles malformed top-level documents from untyped package consumers as neutral scoring input.
- Redis channel locks accept boolean `exists` results from compatible Redis wrappers in addition to numeric/string Redis responses.
- The public `RedisLike` contract advertises numeric, string, and boolean `exists()` results so compatible Redis wrappers do not need casts.
- Runtime creation always replaces package-owned helper singletons, so stale direct initialization cannot leak old Mongo or Redis dependencies into the runtime.
- Attribution accepts numeric and bigint Telegram common-chat IDs by normalizing them to Redis string keys before lookup.
- Message bandit updates normalize poisoned arm counters before applying success/failure rewards.
- Intelligence outcome writes repair malformed numeric leaf fields before Mongo `$inc` operations.
- Runner active and continuation gates require exact boolean `true`, so truthy malformed adapter return values cannot accidentally allow sends.
- Redis promotion tracker fails visibly when pipeline `exec()` returns command-level errors.
- Runner sleep isolates adapter timer failures so custom sleep implementations cannot abort a completed direct cycle or started loop.
- Runner success accounting records custom-slot sends against the selected candidate strategy, so bandit-only strategies are not collapsed into `natural_template`.
- Intelligence conversion and paid-conversion writes repair corrupted numeric leaves before Mongo `$inc` operations.
- Runner queues preserve the selected message strategy so later deletion accounting and bandit penalties do not collapse custom-slot strategies into `natural_template`.
- Expected-value scoring treats future-dated online/view timestamps as stale so corrupted clocks cannot create freshness bonuses.
- Intelligence success and follow-up outcome writes repair `totalSendsToChannel`, `followupTotal`, and `followupSuccessCount` before Mongo `$inc` operations.
- Runner normalizes loaded/direct channel IDs and skips malformed channel rows before adapter, account, queue, or intelligence flow.
- Public message-index policy APIs trim message indexes before strategy and deletion-action mapping.
- Strategy values are normalized across policy input, externally owned queue data, runner deletion accounting, bandit construction/restore, and intelligence writes.
- Promotion queues reject malformed non-object entries and remove invalid strategy values instead of leaking them through `readyForCheck()`.
- Promotion queues return only documented queue fields from `readyForCheck()` and drop unknown fields supplied by untyped callers.
- Public channel selection returns normalized channel IDs, matching the normalized IDs it uses for dedupe, intelligence lookup, and ranking.
- Runtime Redis dependency checks are feature-specific, so lock-only Redis wrappers can enable locks without tracker/list methods.
- Public bandit updates trim strategy values, and per-channel strategy selection normalizes persisted strategy keys before sampling.
- Percentile aggregation coerces active-channel and intelligence numeric fields before Mongo arithmetic so corrupted string counters do not discard valid rows.
- Redis tracker reads filter future-dated corrupted history and last-promoter records before returning them to attribution callers.
- Message policy and runner flow ignore non-array available-message lists from untyped callers instead of throwing or queueing incorrect counts.
- Percentile aggregation clamps converted negative counters to zero before building population buckets.
- Direct send-failure outcomes apply the same strategy-arm recency discount as send successes and message deletions.
- Runner health snapshots expose lifecycle, queue, send/failure/deletion/follow-up, and last-error state for watchdogs.
- Started runners keep looping after transient active-state exceptions instead of exiting permanently.
- `PromotionRunnerSupervisor` restarts exited runners with backoff and exposes hooks for host-owned Telegram health/reconnect checks.

## Practical Scenario Matrix

- New channel with no intelligence doc.
- Optimized channel with high expected value.
- Hostile or cooldown channel.
- Premium account with days left and non-premium account with zero days.
- High delete-rate channel under p75/p90 gates.
- Recent failure and recently queued channel.
- Redis lock outage before send and after send.
- Mongo/intelligence write outage after Telegram send.
- Telegram send throws, returns failed candidate, or returns no sendable content.
- Long-running runner gets transient Mongo/Redis/adapter failure during a cycle and must continue next cycle.
- Adapter log sink throws.
- Telegram message check returns `exists`, `deleted`, `unknown`, or throws.
- Follow-up scheduling suppressed by non-premium, cap, inactive adapter, `shouldContinue=false`, or missing channel.
- Multi-account runtime with distinct mobile/clientId attribution.
- Redis attribution record is stale, malformed, or future-dated.
- Stored intelligence metrics contain `NaN`, `Infinity`, negative counters, or out-of-range cached rates.
- Injected random functions return `NaN`, throw, or return outside `[0,1)`.
- Message queue is constructed with invalid or fractional capacity.
- Telegram send result contains `sent=true` with `messageId` missing, `NaN`, non-integer, or non-positive.
- Redis caller passes blank or whitespace identifiers.
- Profile/classification/saturation/online/view updates receive malformed numerical inputs.
- Package consumer importing only from `promo-helper`.
- Redis percentile cache contains valid JSON with missing, unordered, or non-numeric buckets.
- Runtime account is created with whitespace-padded identifiers or blank channel IDs.
- Serialized bandit state contains negative, `NaN`, or unknown-arm counters.
- Runner options contain `NaN`, `Infinity`, negative, or fractional timing, batch, and follow-up cap values.
- Adapter stats return malformed premium days before follow-up scheduling.
- Queue check sees an existing Telegram message but stats loading fails before follow-up scheduling.
- Externally owned queue contains a future-dated or malformed timestamp for a deleted message.
- Previous local promotion failure has a future-dated or invalid `lastCheckTimestamp`.
- Available message IDs contain blanks, whitespace, or malformed runtime values.
- Attribution receives whitespace-padded, duplicate, blank, or malformed common chat IDs.
- Redis APIs receive non-string identifiers from JavaScript callers.
- View engagement check returns zero views for a valid participant count.
- Failure recording receives a malformed or blank Telegram error type.
- Adapter active/continuation/recent-queue callbacks throw during a selected-channel loop.
- Message policy receives an unknown bandit strategy from an untyped package consumer.
- Serialized bandit restore receives `null` or another non-array value.
- Channel classifier/profile/classification APIs receive non-string labels or non-object classification payloads.
- Channel selection input contains duplicate, whitespace-padded, blank, or malformed channel IDs.
- Channel intelligence service is called directly by JavaScript consumers with whitespace-padded channel IDs, blank channel IDs, duplicate batch IDs, or malformed top-channel limits.
- Externally owned promotion queues contain blank channel IDs, invalid Telegram message IDs, malformed timestamps, or malformed available-message counts.
- Bandit constructors receive duplicate, unknown, blank, or malformed strategy arrays from untyped package consumers.
- Conversion attribution has one failed Redis lookup among otherwise valid common chats.
- Conversion attribution discovers a source but analytics persistence fails transiently.
- Redis history and last-promoter cache contain valid JSON with whitespace-padded identifiers.
- Adapter `getStats()` returns malformed data during selection, send planning, follow-up scheduling, or post-send delay.
- Adapter `checkMessage()` returns a malformed status object.
- Percentile provider throws or returns non-finite ranks during eligibility checks.
- Intelligence docs passed into selection include null or malformed entries.
- Standalone expected-value scoring receives a partial/corrupted document from an untyped consumer.
- Expected-value scoring receives a throwing or malformed percentile rank callback.
- Adapter `sendPromotion()` returns `null`, missing `messageIndex`, non-string `messageIndex`, or otherwise malformed result data.
- Direct intelligence service or runtime account calls pass an invalid message strategy string.
- Externally owned queue receives a malformed message index.
- Stored intelligence document has a null or malformed `strategies` map before message-strategy selection.
- Feature flag parsing receives `null`, arrays, or non-string env values from untyped callers.
- Existing intelligence documents have `strategies`, `errors`, `deletionTiming`, `onlineTrend`, or `viewEngagement` corrupted to `null`.
- Mongo aggregation returns a percentile facet row whose `values` field is not an array.
- Adapter stats loading fails during selection planning or per-channel message planning.
- Adapter intelligence batch loading fails while channel rows are otherwise sendable.
- Adapter channel loading returns `null`, primitives, or records with missing channel IDs among valid channels.
- Attribution callers pass truthy non-boolean paid flags such as `'true'`.
- Package consumers call `createPromotionRuntime`, `createAccountContext`, or `PromotionFlowRunner` with `null`, `{}`, or malformed dependencies.
- Package consumers pass `null`, arrays, string booleans, or malformed top-level objects to public policy functions.
- Active-channel percentile aggregation throws or returns non-array results during refresh.
- Package consumers construct Redis lock/tracker, attribution, intelligence, or percentile services directly with missing dependencies.
- Package consumers pass `null` or arrays as singleton init options instead of `{ replace: true }`.
- Serialized bandit restore receives `null`, primitive entries, unknown strategy entries, or numeric fields with string/NaN/negative values.
- Untyped callers or tests accidentally overwrite bandit `arms` storage with malformed objects before calling update/stats/reset/serialize.
- Redis-compatible clients return string exists flags, malformed list values, or malformed pipeline objects.
- Optional helper singletons are initialized directly before `createPromotionRuntime()` is called with Redis-backed features disabled.
- Selection ratio options overlap enough that initial exploit/explore/re-eval slices would exceed batch capacity.
- Externally owned runner queues return malformed ready rows or throw while removing completed rows.
- Follow-up delay callers pass `NaN`, `Infinity`, or negative base delay values.
- Mongo-compatible collection cursors are missing `sort`/`limit`, return non-array rows, or include malformed channel documents.
- Direct `runOnce()` callers see `loadChannels()` throw because the backing channel store is temporarily unavailable.
- Package consumers pass a structurally valid but throwing custom bandit object into `PromotionFlowRunner`.
- Package consumers call `computeExpectedValue()` with `null`, arrays, or malformed top-level values.
- Redis-compatible lock clients return boolean `true` for `exists()`.
- TypeScript package consumers provide Redis-compatible clients whose `exists()` returns boolean or string values.
- Helper singletons are initialized directly before the first runtime creation while Redis-backed features are enabled.
- Telegram common-chat IDs arrive from untyped/GramJS callers as numbers or bigints instead of strings.
- Untyped callers corrupt in-memory bandit arm numeric counters before the next update.
- Existing Mongo intelligence documents have string, `NaN`, or negative numeric leaves under strategy, deletion, or error counters before outcome writes.
- Adapter `isActive()` or `shouldContinue()` returns truthy non-boolean values such as `'false'` or `'true'`.
- Redis pipeline `exec()` resolves with ioredis-style command error tuples instead of throwing.
- Adapter-provided `sleep()` throws after a send or between started-loop cycles.
- Bandit selects `markov_chain`, `question_doubt`, or `curiosity_gap`, which are sent through the `custom` slot but must keep their own success counters.
- Existing Mongo intelligence documents have string, `NaN`, or negative `conversions` / `paidConversions` leaves before attribution writes.
- A bandit-selected custom-slot message is sent successfully, later deleted, and must record the deletion against the same selected strategy.
- Stored online/view engagement timestamps are accidentally future-dated and must not boost expected value.
- Existing Mongo intelligence documents have string, `NaN`, or negative `totalSendsToChannel` / follow-up counter leaves before success or deletion writes.
- Adapter channel loading returns whitespace-padded IDs, blank IDs, or malformed rows before runner selection and send flow.
- Direct `processChannel()` callers pass malformed channel snapshots from untyped package code.
- Public deletion-policy callers pass whitespace-padded message indexes such as `' custom '` or `' 0 '`.
- Public policy, queue, bandit, or intelligence callers pass whitespace-padded strategy values such as `' ai_contextual '`.
- Direct queue callers pass `null`, primitives, or invalid strategy strings to `PromotionMessageQueue.enqueue()`.
- Package consumers call `selectPromotionChannels()` directly with whitespace-padded channel IDs and expect normalized selected/proven/stale/untested results.
- Runtime is created with only lock-compatible Redis methods (`get`, `set`, `exists`) while attribution and percentile features are disabled or unavailable.
