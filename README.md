# tg-promo-helper

Shared Telegram promotion intelligence package used by `tg-aut-local`, `promote-clients-local`, and API/provider services.

## Package Shape

- `tg-promo-helper`: the only public package entry. Consumers import promotion APIs and shared types from this root.
- `src/channel-message-promotions`: current internal channel message promotion family.
- `src/types`: internal shared structural types for Mongo/Redis adapters and percentile snapshots, re-exported from the root.

## Build And Validate

```bash
npm run clean
npm run build
npm test -- --runInBand
npm --cache /private/tmp/tg-promo-helper-npm-cache pack --dry-run
```

## Runtime Model

Apps own Telegram clients, message materialization, Mongo/Redis instances, and process lifecycle. The internal `channel-message-promotions` family owns reusable message-promotion policy, scoring, channel intelligence, cross-account coordination, attribution, and the promotion flow runner. Future families, such as channel reactions, should be added as sibling folders under `src` and re-exported through `src/index.ts`.

## 24/7 Runner Supervision

`PromotionFlowRunner` exposes `getHealth()` with queue size, lifecycle timestamps, counters, last error, and send/delete/follow-up activity. The runner keeps its started loop alive after transient `isActive()` exceptions and continues after isolated cycle failures.

Use `PromotionRunnerSupervisor` around each account runner when the host app needs 24/7 behavior. The supervisor recreates runners after exit, applies restart backoff, can pause through `shouldRun()`, and can stop a runner that has no recent activity through `stuckAfterMs`.

Telegram reconnect/session repair still belongs in the host app because the host owns the Telegram client. Wire that into `shouldRun()`, `createRunner()`, and the supervisor hooks.
# tg-prom-helper
