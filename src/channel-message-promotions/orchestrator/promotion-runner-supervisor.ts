import type { PromotionChannelSnapshot } from '../policy';
import { PromotionFlowRunner } from './promotion-flow-runner';
import type { PromotionRunnerHealthSnapshot } from './promotion-flow.types';

export type PromotionSupervisorStatus = 'idle' | 'running' | 'stopping' | 'stopped';

export interface PromotionRunnerSupervisorHealth {
  status: PromotionSupervisorStatus;
  startedAt: number | null;
  stoppedAt: number | null;
  lastRunnerStartedAt: number | null;
  lastRunnerStoppedAt: number | null;
  lastRestartAt: number | null;
  restartCount: number;
  consecutiveRunnerFailures: number;
  lastErrorAt: number | null;
  lastError: string | null;
  lastStuckAt: number | null;
  runner: PromotionRunnerHealthSnapshot | null;
}

export interface PromotionRunnerSupervisorOptions<TChannel extends PromotionChannelSnapshot> {
  createRunner(): PromotionFlowRunner<TChannel> | Promise<PromotionFlowRunner<TChannel>>;
  shouldRun?(): boolean | Promise<boolean>;
  onRestart?(health: PromotionRunnerSupervisorHealth): void | Promise<void>;
  onStuck?(health: PromotionRunnerSupervisorHealth): void | Promise<void>;
  onError?(error: string, health: PromotionRunnerSupervisorHealth): void | Promise<void>;
  sleep?(ms: number): Promise<void>;
  minRestartDelayMs?: number;
  maxRestartDelayMs?: number;
  restartBackoffFactor?: number;
  inactiveDelayMs?: number;
  stuckAfterMs?: number;
  healthCheckIntervalMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PromotionRunnerSupervisor<TChannel extends PromotionChannelSnapshot> {
  private readonly options: PromotionRunnerSupervisorOptions<TChannel>;
  private currentRunner: PromotionFlowRunner<TChannel> | null = null;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private sleepWakeups = new Set<() => void>();
  private status: PromotionSupervisorStatus = 'idle';
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private lastRunnerStartedAt: number | null = null;
  private lastRunnerStoppedAt: number | null = null;
  private lastRestartAt: number | null = null;
  private restartCount = 0;
  private consecutiveRunnerFailures = 0;
  private currentRunnerStoppedAsStuck = false;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;
  private lastStuckAt: number | null = null;

  constructor(options: PromotionRunnerSupervisorOptions<TChannel>) {
    if (!isRecord(options) || typeof options['createRunner'] !== 'function') {
      throw new Error('PromotionRunnerSupervisor createRunner is required');
    }
    this.options = options;
  }

  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    this.stopRequested = false;
    this.status = 'running';
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.loopPromise = this.runLoop()
      .finally(() => {
        this.stopWatchdog();
        this.currentRunner = null;
        this.status = 'stopped';
        this.stoppedAt = Date.now();
        this.loopPromise = null;
      });
    return this.loopPromise;
  }

  stop(): void {
    this.stopRequested = true;
    this.status = this.status === 'idle' ? 'stopped' : 'stopping';
    this.currentRunner?.stop();
    this.stopWatchdog();
    for (const wake of this.sleepWakeups) {
      wake();
    }
    this.sleepWakeups.clear();
  }

  getCurrentRunner(): PromotionFlowRunner<TChannel> | null {
    return this.currentRunner;
  }

  getHealth(): PromotionRunnerSupervisorHealth {
    return {
      status: this.status,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastRunnerStartedAt: this.lastRunnerStartedAt,
      lastRunnerStoppedAt: this.lastRunnerStoppedAt,
      lastRestartAt: this.lastRestartAt,
      restartCount: this.restartCount,
      consecutiveRunnerFailures: this.consecutiveRunnerFailures,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      lastStuckAt: this.lastStuckAt,
      runner: this.currentRunner?.getHealth() ?? null,
    };
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      if (!(await this.shouldRun())) {
        await this.sleep(safeDelayMs(this.options.inactiveDelayMs, 5000));
        continue;
      }

      let runner: PromotionFlowRunner<TChannel> | null = null;
      try {
        runner = await this.options.createRunner();
        if (!(runner instanceof PromotionFlowRunner)) {
          throw new Error('PromotionRunnerSupervisor createRunner returned invalid runner');
        }
        this.currentRunner = runner;
        this.currentRunnerStoppedAsStuck = false;
        this.lastRunnerStartedAt = Date.now();
        this.startWatchdog();
        await runner.start();
        if (!this.currentRunnerStoppedAsStuck) {
          this.consecutiveRunnerFailures = 0;
        }
      } catch (error) {
        this.recordError(normalizeError(error));
      } finally {
        this.stopWatchdog();
        this.currentRunner?.stop();
        this.lastRunnerStoppedAt = Date.now();
        this.currentRunner = null;
        this.currentRunnerStoppedAsStuck = false;
      }

      if (this.stopRequested) break;
      if (!(await this.shouldRun())) {
        await this.sleep(safeDelayMs(this.options.inactiveDelayMs, 5000));
        continue;
      }
      this.restartCount += 1;
      this.lastRestartAt = Date.now();
      await this.callHook('onRestart', () => this.options.onRestart?.(this.getHealth()));
      await this.sleep(this.restartDelayMs());
    }
  }

  private async shouldRun(): Promise<boolean> {
    try {
      if (!this.options.shouldRun) return true;
      return await this.options.shouldRun() === true;
    } catch (error) {
      this.recordError(`shouldRun failed: ${normalizeError(error)}`);
      return false;
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const stuckAfterMs = safeDelayMs(this.options.stuckAfterMs, 0);
    if (stuckAfterMs <= 0) return;
    const intervalMs = safeIntervalMs(this.options.healthCheckIntervalMs, Math.max(1000, Math.floor(stuckAfterMs / 3)));
    this.watchdog = setInterval(() => {
      void this.checkRunnerHealth(stuckAfterMs);
    }, intervalMs);
  }

  private stopWatchdog(): void {
    if (!this.watchdog) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private async checkRunnerHealth(stuckAfterMs: number): Promise<void> {
    const runner = this.currentRunner;
    if (!runner) return;
    const health = runner.getHealth();
    if (!health.running) return;
    const lastActivityAt = latestTimestamp([
      health.lastCycleFinishedAt,
      health.lastQueueCheckFinishedAt,
      health.lastSuccessfulSendAt,
      health.lastSendFailureAt,
      health.lastDeletionAt,
      health.startedAt,
    ]);
    if (lastActivityAt === null || Date.now() - lastActivityAt < stuckAfterMs) return;
    this.lastStuckAt = Date.now();
    this.currentRunnerStoppedAsStuck = true;
    this.recordError(`runner stuck for ${Date.now() - lastActivityAt}ms`);
    await this.callHook('onStuck', () => this.options.onStuck?.(this.getHealth()));
    runner.stop();
  }

  private restartDelayMs(): number {
    const minDelay = safeDelayMs(this.options.minRestartDelayMs, 1000);
    const maxDelay = Math.max(minDelay, safeDelayMs(this.options.maxRestartDelayMs, 60_000));
    const factor = safeBackoffFactor(this.options.restartBackoffFactor);
    const delay = minDelay * Math.pow(factor, Math.max(0, this.consecutiveRunnerFailures - 1));
    return Math.min(maxDelay, Math.floor(delay));
  }

  private async sleep(ms: number): Promise<void> {
    if (this.stopRequested) return;
    let wake: (() => void) | null = null;
    try {
      const stopPromise = new Promise<void>((resolve) => {
        wake = resolve;
        this.sleepWakeups.add(resolve);
      });
      const sleepPromise = (this.options.sleep || defaultSleep)(safeDelayMs(ms, 0)).catch((error) => {
        this.recordError(`supervisor sleep failed: ${normalizeError(error)}`);
        return defaultSleep(safeDelayMs(ms, 0));
      });
      await Promise.race([sleepPromise, stopPromise]);
    } catch (error) {
      this.recordError(`supervisor sleep failed: ${normalizeError(error)}`);
    } finally {
      if (wake) this.sleepWakeups.delete(wake);
    }
  }

  private async callHook(
    name: 'onRestart' | 'onStuck',
    hook: () => Promise<void> | void | undefined,
  ): Promise<void> {
    try {
      await hook();
    } catch (error) {
      this.recordError(`${name} failed: ${normalizeError(error)}`);
    }
  }

  private recordError(error: string): void {
    this.consecutiveRunnerFailures += 1;
    this.lastErrorAt = Date.now();
    this.lastError = compact(error);
    try {
      void Promise.resolve(this.options.onError?.(this.lastError, this.getHealth())).catch(() => undefined);
    } catch {
      // Health reporting must never break the supervisor loop.
    }
  }
}

function latestTimestamp(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
}

function safeDelayMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function safeIntervalMs(value: unknown, fallback: number): number {
  return Math.max(1000, safeDelayMs(value, fallback));
}

function safeBackoffFactor(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 1 ? value : 2;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
