import { messageIndexToStrategy } from './message-policy';
import type { DeletionAction, DeletionPolicyResult } from './policy.types';

export function evaluateDeletionPolicy(messageIndex: string, availableMessageCount: number = 0): DeletionPolicyResult {
  const safeMessageIndex = normalizeMessageIndex(messageIndex);
  const safeAvailableMessageCount = Number.isFinite(availableMessageCount) && availableMessageCount > 0
    ? Math.floor(availableMessageCount)
    : null;
  const actions: DeletionAction[] = [];
  if (safeMessageIndex === 'followUp') {
    actions.push('increment_dm_restriction');
  } else if (safeMessageIndex === 'custom' || safeMessageIndex === 'ai') {
    actions.push('increment_word_restriction');
  } else {
    actions.push('remove_message_index');
  }

  if (safeMessageIndex === '0' && safeAvailableMessageCount === 1) {
    actions.push('ban_no_available_messages');
  }

  return {
    strategy: messageIndexToStrategy(safeMessageIndex),
    actions,
  };
}

function normalizeMessageIndex(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
