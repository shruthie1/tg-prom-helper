import { symmetricJitter } from './delay-policy';
import { safeNonNegative } from './policy-number-utils';
import type { FollowUpPolicyInput, FollowUpPolicyResult } from './policy.types';

export function evaluateFollowUpScheduling(input: FollowUpPolicyInput): FollowUpPolicyResult {
  if (!isRecord(input)) return { shouldSchedule: false, reason: 'invalid follow-up input' };
  if (input.isFollowUp === true) return { shouldSchedule: false, reason: 'already follow-up' };
  if (input.isCleanedUp === true) return { shouldSchedule: false, reason: 'instance cleaned up' };
  if (input.channelAvailable === false) return { shouldSchedule: false, reason: 'channel unavailable' };
  if (safeDaysLeft(input.daysLeft) <= 0) return { shouldSchedule: false, reason: 'account not premium' };
  if (
    input.activeFollowUpCount !== undefined
    && input.maxFollowUpCount !== undefined
    && safeNonNegative(input.activeFollowUpCount) >= safeNonNegative(input.maxFollowUpCount)
  ) {
    return { shouldSchedule: false, reason: 'follow-up cap reached' };
  }
  return { shouldSchedule: true, reason: null };
}

export function calculateFollowUpDelay(
  baseDelayMs: number,
  jitterRangeMs: number,
  random: () => number = Math.random,
): number {
  return Math.max(0, safeNonNegative(baseDelayMs) + symmetricJitter(jitterRangeMs, random));
}

function safeDaysLeft(daysLeft: number | undefined): number {
  if (daysLeft === undefined) return 1;
  return safeNonNegative(daysLeft);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
