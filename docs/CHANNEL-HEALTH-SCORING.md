# Channel Promotion Health Scoring

## Status: Core implementation complete

Implemented in this workspace:

| Area | Status |
|------|--------|
| Shared health scoring API | Done: `evaluateChannelPromotionHealth()` exported by `tg-prom-helper` |
| Shared failure persistence API | Done: `resolvePromotionFailureAction()` exported by `tg-prom-helper` |
| Error classifier sync | Done: `TELEGRAM ENTITY NOT FOUND` / `ENTITY NOT FOUND` classify as invalid channel |
| Hydration ban handling | Done: `mergeHydratedChannelFacts()` preserves `banned` and never clears `bannedAt` |
| Consumer wiring | Done: `tg-aut` and `promote-clients` use shared health/failure logic |
| Exhausted templates | Done: no longer hard-ban channels; health score applies content penalty |
| Low-activity deletion check | Done in `promote-clients`: no longer writes `banned` / `forbidden` |
| Schema/type support | Done: `bannedAt`, `recentUniqueUsers`, and `lastUniqueUserCheckAt` added to service types and CommonTgService active-channel schemas/DTOs |
| Verification | Done: helper build/tests plus cross-repo TypeScript checks pass |

Remaining operational follow-up:

| Area | Status |
|------|--------|
| Existing Mongo documents | Pending: run the `bannedAt` backfill migration for old `banned: true` records |
| Probe execution | Pending: consumers expose `probeEligible`, but do not yet schedule/send recovery probes |
| Package/deploy rollout | Pending: publish or deploy the rebuilt helper and dependent services |

## Problem

The `banned: boolean` field on `activeChannels` is set by multiple triggers with different semantics, and `mergeHydratedChannelFacts` unconditionally clears it. Additionally, tg-aut and promote-clients handle promotion failures differently — they must be fully in sync.

### Current triggers that set `banned: true`

| Trigger | What it means | Should block promotions? |
|---------|--------------|--------------------------|
| `USER_BANNED_IN_CHANNEL` error | Channel has active moderation that caught us | YES — global, will catch other accounts too |
| `availableMsgs` exhausted (all templates deleted by admins) | Admins actively remove our content | MAYBE — AI/custom messages might still work |
| Low unique users (<8 after deletion check) | Channel is dead / inactive | YES — no audience |
| `enforceActiveChannelSafetyState` bulk operation | Channels with `availableMsgs: []` | MAYBE — same as exhaustion |

### Current problems

1. **Hydration clears `banned: false` unconditionally** — un-bans channels every 30 days, creating infinite retry loops
2. **tg-aut and promote-clients disagree** on error handling (tg-aut uses classifier, promote-clients uses raw string matching)
3. **No data-driven recovery** — a channel banned 6 months ago with no way to test if the ban was lifted or admins changed
4. **Binary decision** — no way to express "degraded but still usable for AI messages" vs "completely dead"

---

## Solution: Health Scoring + Unified Error Handling

### Principles

1. **`banned` remains global** — if one account gets caught, the channel has active moderation. All accounts should avoid it.
2. **Hydration NEVER clears `banned`** — the Telegram API cannot detect account-level bans from channel metadata alone.
3. **`banned` can only be cleared by**: (a) a successful send that proves the ban was lifted, or (b) a deliberate time-based probe after sufficient cooldown with proven prior success.
4. **Both services use the same function** from `tg-prom-helper` for error handling and health evaluation.
5. **Health score replaces hard binary** — channels can be "degraded" (lower priority, AI-only messages) without being fully blocked.

---

## Data Model

### No new fields required

All inputs to the health score already exist on `activeChannels`:

```typescript
// Already on every activeChannels document:
{
  canSendMsgs: boolean,         // composite sendability flag
  broadcast: boolean,
  restricted: boolean,
  private: boolean,
  forbidden: boolean,
  sendMessages: boolean,        // defaultBannedRights.sendMessages
  sendPlain: boolean,           // defaultBannedRights.sendPlain
  banned: boolean,              // global ban flag (SET on error, CLEARED only on proven success)
  participantsCount: number,
  successMsgCount: number,      // lifetime successful sends that still exist
  failureMsgCount: number,      // lifetime failed send attempts
  deletedCount: number,         // messages deleted by channel admins
  followupMsgSuccessCount: number,
  followupMsgFailureCount: number,
  availableMsgs: string[],      // remaining template IDs (shrinks when admins delete)
  wordRestriction: number,      // times content-filtered messages were deleted
  dMRestriction: number,        // times DM/link-style messages were deleted
  recentUniqueUsers: number,    // recent unique users seen in channel history checks
  lastUniqueUserCheckAt: number,// timestamp when recentUniqueUsers was measured
  lastMessageTime: number,      // timestamp of last successful send
  lastHydratedAt: number,       // timestamp of last live metadata refresh
}
```

### New field added

```typescript
{
  bannedAt: number | null,      // timestamp when banned was set to true (for cooldown calculation)
}
```

This is the only schema addition — needed to compute "how long has this channel been banned" for probe eligibility.

---

## Function: `evaluateChannelPromotionHealth`

### Input

```typescript
export interface ChannelPromotionHealthInput {
  // Sendability state
  canSendMsgs?: boolean | null;
  broadcast?: boolean | null;
  restricted?: boolean | null;
  private?: boolean | null;
  forbidden?: boolean | null;
  sendMessages?: boolean | null;
  sendPlain?: boolean | null;
  banned?: boolean | null;
  bannedAt?: number | Date | null;

  // Counters
  successMsgCount?: number | null;
  failureMsgCount?: number | null;
  deletedCount?: number | null;
  followupMsgSuccessCount?: number | null;
  followupMsgFailureCount?: number | null;
  availableMsgs?: string[] | null;
  wordRestriction?: number | null;
  dMRestriction?: number | null;
  recentUniqueUsers?: number | null;
  lastUniqueUserCheckAt?: number | Date | null;
  participantsCount?: number | null;

  // Timing
  lastMessageTime?: number | null;
  lastHydratedAt?: number | Date | null;

  // Optional: current timestamp for testing
  now?: number;
}
```

### Output

```typescript
export interface ChannelPromotionHealthResult {
  promotable: boolean;
  reason: string;
  score: number;                // 0–100
  probeEligible: boolean;       // true if banned but eligible for a retry probe
  signals: {
    sendability: 'pass' | 'fail';
    banned: boolean;
    contentHealth: 'healthy' | 'degraded' | 'exhausted';
    deletionRate: 'low' | 'moderate' | 'severe';
    channelActivity: 'active' | 'low' | 'dead';
  };
}
```

### Scoring Logic

```
HARD BLOCKS (score = 0, promotable = false):
├── sendability fail (broadcast, restricted, private, forbidden, sendMessages, sendPlain)
└── banned = true AND NOT probe-eligible

PROBE ELIGIBILITY (banned = true but may be worth retrying):
├── bannedAt > 30 days ago
├── AND successMsgCount >= 3 (channel previously worked)
├── AND deletionRate is NOT 'severe'
├── AND live metadata flags are otherwise sendable
│   (the persisted canSendMsgs=false written with banned=true is ignored for this check)
└── Result: promotable = false, probeEligible = true
    (caller decides whether to attempt a single probe)

SCORED SIGNALS (all contribute to 0-100 score):
├── Content Health (availableMsgs pool)
│   ├── 0 templates remaining: -40 points ('exhausted')
│   ├── 1–5 templates remaining: -15 points ('degraded')
│   └── 6+ templates remaining: 0 ('healthy')
│
├── Deletion Rate (deletedCount vs totalMessages)
│   ├── ≥70% deleted AND ≥5 deletions: -35 points ('severe')
│   ├── ≥40% deleted AND ≥3 deletions: -15 points ('moderate')
│   ├── ≥3 deletions but no surviving messages: -30 points ('severe')
│   └── Otherwise: 0 ('low')
│
├── Failure Rate (failureCount / totalAttempts)
│   ├── ≥80% failure AND ≥3 attempts: -25 points
│   ├── ≥50% failure AND ≥3 attempts: -10 points
│   └── Otherwise: 0
│
├── Channel Activity (participantsCount)
│   ├── fresh recentUniqueUsers < 8: -80 total points ('dead' activity + low-unique penalty)
│   ├── fresh recentUniqueUsers < 20: -5 points ('low')
│   ├── < 50 participants: -20 points ('dead')
│   ├── < 200 participants: -5 points ('low')
│   └── 200+ participants: 0 ('active')
│
└── Moderation Pressure (wordRestriction + dMRestriction)
    ├── Combined ≥ 8: -15 points
    ├── Combined ≥ 4: -5 points
    └── Otherwise: 0

FINAL VERDICT:
├── score > PROMOTABLE_THRESHOLD (default: 20) → promotable = true
└── score ≤ 20 → promotable = false, reason = compound issues
```

### Minimum Data Requirements

The scoring function requires `totalAttempts >= 3` (successMsgCount + failureMsgCount) before applying failure rate penalties. Channels with insufficient data get the benefit of the doubt — only sendability and banned status apply as hard blocks.

This prevents newly added channels from being incorrectly scored down.

---

## Function: `resolvePromotionFailureAction`

Replaces the divergent error handling in both services with a single function.

### Input

```typescript
export interface PromotionFailureActionInput {
  error: unknown;           // The Telegram error (string, Error object, or error record)
  channelId: string;
}
```

### Output

```typescript
export interface PromotionFailureAction {
  // What to write to the shared activeChannels document
  channelUpdate: Partial<{
    canSendMsgs: false;
    banned: true;
    bannedAt: number;
    private: true;
    forbidden: true;
    restricted: true;
  }> | null;

  // Whether to skip all persistence (transient/runtime error)
  skipPersist: boolean;

  // Classification metadata for logging
  code: string;
  reason: string;
  scope: string;
}
```

### Logic

```typescript
export function resolvePromotionFailureAction(error: unknown): PromotionFailureAction {
  const classified = classifyTelegramChannelError(error);

  // Transient / runtime / reaction errors — don't persist anything
  if (!classified.shouldPersistGlobal && !classified.shouldPersistAccount) {
    return { channelUpdate: null, skipPersist: true, ...classified };
  }

  // USER_BANNED_IN_CHANNEL — global ban (channel has active moderation)
  if (classified.code === 'USER_BANNED_IN_CHANNEL') {
    return {
      channelUpdate: { banned: true, bannedAt: Date.now(), canSendMsgs: false },
      skipPersist: false,
      ...classified,
    };
  }

  // CHANNEL_PRIVATE
  if (classified.reason === 'private') {
    return {
      channelUpdate: { private: true, canSendMsgs: false },
      skipPersist: false,
      ...classified,
    };
  }

  // CHANNEL_INVALID / CHAT_INVALID / entity not found
  if (classified.reason === 'invalid') {
    return {
      channelUpdate: { forbidden: true, canSendMsgs: false },
      skipPersist: false,
      ...classified,
    };
  }

  // Globally persistable errors
  if (classified.shouldPersistGlobal) {
    return {
      channelUpdate: { restricted: true, canSendMsgs: false },
      skipPersist: false,
      ...classified,
    };
  }

  // Account-level errors (FLOOD_WAIT, ALLOW_PAYMENT_REQUIRED) — don't mutate channel state
  return { channelUpdate: null, skipPersist: false, ...classified };
}
```

### Required fix in `classifyTelegramChannelError`

Add `TELEGRAM ENTITY NOT FOUND` pattern:

```typescript
// Add BEFORE the UNKNOWN fallback:
if (message.includes('TELEGRAM ENTITY NOT FOUND') || message.includes('ENTITY NOT FOUND')) {
  return classification('CHANNEL_INVALID', 'global', 'invalid', null, false, true, false, false, true, false);
}
```

---

## Unified Consumer Code (IDENTICAL in both services)

```typescript
// In BOTH tg-aut/PromotionEngine.ts AND promote-clients/Promotion.ts:
import { resolvePromotionFailureAction } from 'promo-helper';

private async applyPromotionFailureState(channelId: string, errorMsg: string): Promise<void> {
  const action = resolvePromotionFailureAction(errorMsg);

  if (action.skipPersist) {
    this.log('debug', `PROMO failure scoped locally | ${channelId} | ${action.code} | ${action.reason}`);
    return;
  }

  if (action.channelUpdate) {
    try {
      await db.updateActiveChannel({ channelId }, action.channelUpdate);
    } catch (error) {
      parseError(error, `[${this.mobile}] Failed to persist failure state for ${channelId}`, false);
    }
  }

  this.log('debug', `PROMO failure persisted | ${channelId} | ${action.code} | ${action.reason} | scope=${action.scope}`);
}
```

---

## Hydration Rules

### `mergeHydratedChannelFacts` — what it can and cannot touch

| Field | Hydration updates? | Reason |
|-------|-------------------|--------|
| `broadcast` | YES | Live Telegram API data, always accurate |
| `restricted` | YES | Live API data |
| `sendMessages` | YES | From `defaultBannedRights`, always accurate |
| `sendPlain` | YES | From `defaultBannedRights`, always accurate |
| `canSendMsgs` | YES | Computed from above fields |
| `private` | CONDITIONAL | Clear only if `canSendMsgs = true` (proves channel is accessible) |
| `forbidden` | CONDITIONAL | Clear only if `canSendMsgs = true` |
| `banned` | **NEVER** | Cannot verify — Telegram API doesn't expose account bans from metadata |
| `bannedAt` | **NEVER** | Paired with `banned` |
| `successMsgCount` | **NEVER** | Accumulated over time, only promotion events modify |
| `failureMsgCount` | **NEVER** | Same |
| `deletedCount` | **NEVER** | Same |
| `availableMsgs` | **NEVER** | Template pool, only deletion policy modifies |
| `wordRestriction` | **NEVER** | Same |
| `dMRestriction` | **NEVER** | Same |

### Implementation change

```typescript
// In mergeHydratedChannelFacts:
// Preserve the existing banned state. Never force banned=false from metadata.
// Hydration may report live sendability, but it cannot prove an account/channel ban is gone.
```

---

## Banned Channel Recovery

### How a banned channel becomes promotable again

There is **no automatic un-ban**. Recovery requires one of:

1. **Probe success**: After `bannedAt` is >30 days old AND the channel had prior success (`successMsgCount >= 3` AND `deletionRate != severe`), the health function marks it as `probeEligible: true`. The promotion engine can then attempt ONE send. If successful → clear `banned = false, bannedAt = null`. If failed → reset `bannedAt` to now (restart the 30-day cooldown).

2. **Manual override**: Admin clears `banned` via dashboard/API.

### Probe logic (consumer-side, not in the library)

```typescript
// In promotion channel selection:
const health = evaluateChannelPromotionHealth(channel);

if (health.probeEligible && shouldAttemptProbe(channel)) {
  // Attempt single send with lowest-risk message
  // On success: await db.updateActiveChannel({ channelId }, { banned: false, bannedAt: null });
  // On failure: await db.updateActiveChannel({ channelId }, { bannedAt: Date.now() });
}
```

### Probe frequency guard

- Max 1 probe per channel per 30-day window
- Max 3 probes total per promotion cycle (don't burn rate limit budget on probes)
- Use oldest `bannedAt` first (channels banned longest get priority)

---

## Score Interpretation & Message Strategy

| Score | Interpretation | Message strategy |
|-------|---------------|------------------|
| 80–100 | Healthy | Any template, follow-ups enabled |
| 50–79 | Degraded | Prefer low-risk templates (short, no links), follow-ups cautious |
| 21–49 | Poor | AI-only or custom messages, no follow-ups, lower priority in rotation |
| 0–20 | Dead / blocked | Skip entirely |

The score is NOT stored in the database. It's computed at runtime from the stored counters. This means:
- No migration needed for scoring
- Thresholds can be tuned via env vars without redeployment
- Score changes automatically as counters update

---

## Sync Checklist: tg-aut ↔ promote-clients

Both services MUST:

| Behavior | Implementation |
|----------|---------------|
| Classify errors | `resolvePromotionFailureAction()` from `promo-helper` |
| Set `banned: true` | Only via `resolvePromotionFailureAction` (on `USER_BANNED_IN_CHANNEL`) |
| Set `banned: true` + timestamp | Write `{ banned: true, bannedAt: Date.now(), canSendMsgs: false }` |
| Evaluate channel health | `evaluateChannelPromotionHealth()` from `promo-helper` |
| Select promotable channels | DB query for sendability flags → then score filter in application |
| Handle exhausted messages | Score penalty (-40), NOT a hard ban |
| Handle low unique users | Persist `recentUniqueUsers` / `lastUniqueUserCheckAt`; score penalty gates future sends, NOT a hard ban |
| Increment counters | `successMsgCount`, `failureMsgCount`, `deletedCount` via same DB methods |
| Probe banned channels | Health API returns `probeEligible`; consumer-side probe scheduling is pending |

---

## Migration Plan

### Step 1: Add `bannedAt` field

Schema/type support is implemented. Existing MongoDB documents still need a one-time backfill before rollout:

```javascript
// MongoDB migration
db.activeChannels.updateMany(
  { banned: true, bannedAt: { $exists: false } },
  { $set: { bannedAt: Date.now() } }   // approximate — uses "now" since original time is lost
);
```

### Step 2: Deploy `tg-prom-helper` (implemented locally)

- Add `evaluateChannelPromotionHealth()`
- Add `resolvePromotionFailureAction()`
- Add `TELEGRAM ENTITY NOT FOUND` to error classifier
- Remove `banned: false` from `mergeHydratedChannelFacts` patch
- Publish / rebuild

### Step 3: Update both services (implemented locally)

- Replace `applyPromotionFailureState` with unified version
- Replace `isPromotableChannel` / `isChannelHealthy` checks with `evaluateChannelPromotionHealth`
- Remove all direct `{ banned: true }` writes except through `resolvePromotionFailureAction`
- Remove `enforceActiveChannelSafetyState` auto-ban on `availableMsgs: []`

### Step 4: Tune thresholds (operational rollout)

- `CHANNEL_HEALTH_THRESHOLD` env var (default: 20)
- `CHANNEL_PROBE_COOLDOWN_DAYS` env var (default: 30)
- `CHANNEL_PROBE_MIN_SUCCESS` env var (default: 3)
- Monitor health score distribution, adjust as needed

---

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `CHANNEL_HEALTH_THRESHOLD` | 20 | Minimum score for a channel to be promotable |
| `CHANNEL_PROBE_COOLDOWN_DAYS` | 30 | Days after ban before probe is eligible |
| `CHANNEL_PROBE_MIN_SUCCESS` | 3 | Minimum prior successMsgCount to qualify for probe |
| `CHANNEL_PROBE_MAX_PER_CYCLE` | 3 | Max probe attempts per promotion cycle |

---

## Why This Works

1. **No false positives**: `USER_BANNED_IN_CHANNEL` always sets global ban — if the channel has active moderation that caught one account, all accounts are at risk.
2. **No infinite loops**: Hydration never clears `banned`. Only a proven successful send or a deliberate probe (with cooldown) can clear it.
3. **Graceful degradation**: Channels with exhausted templates or high deletion rates get deprioritized (lower score) instead of hard-blocked. AI/custom message paths still work.
4. **Data-driven recovery**: Channels with strong prior success history (high `successMsgCount`, low deletion rate) get probe opportunities after 30 days. Dead channels (no history, severe deletions) never get probed.
5. **Fully in sync**: Both services use identical functions from `tg-prom-helper`. No divergent string matching vs classifier logic.
6. **No schema bloat**: Only one new field (`bannedAt`). Health score is computed at runtime from existing counters.
