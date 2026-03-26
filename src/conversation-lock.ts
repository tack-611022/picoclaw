/**
 * Per-conversation execution lock.
 *
 * Ensures that only one agent execution (chat or task) runs at a time
 * for a given conversation. Different conversations can execute concurrently.
 *
 * Inspired by NanoClaw's GroupQueue but simplified for single-user,
 * per-conversation serialization.
 */

type QueueEntry = {
  resolve: () => void;
};

const locks = new Map<string, QueueEntry[]>();

/**
 * Acquire exclusive execution rights for a conversation.
 * Returns a release function that MUST be called when done.
 *
 * If the conversation is already locked:
 * - `wait: true` (default) — queues and waits for the lock
 * - `wait: false` — throws immediately (for 409 Conflict)
 */
export async function acquireConversationLock(
  conversationId: string,
  options: { wait?: boolean } = {},
): Promise<() => void> {
  const wait = options.wait !== false;

  if (!locks.has(conversationId)) {
    locks.set(conversationId, []);
  }

  const queue = locks.get(conversationId)!;

  if (queue.length > 0 && !wait) {
    throw new ConversationBusyError(conversationId);
  }

  const acquired = new Promise<void>((resolve) => {
    queue.push({ resolve });
    if (queue.length === 1) {
      resolve();
    }
  });

  await acquired;

  return () => {
    queue.shift();
    if (queue.length > 0) {
      queue[0].resolve();
    } else {
      locks.delete(conversationId);
    }
  };
}

/**
 * Check whether a conversation currently has an active execution.
 */
export function isConversationLocked(conversationId: string): boolean {
  const queue = locks.get(conversationId);
  return Boolean(queue && queue.length > 0);
}

export class ConversationBusyError extends Error {
  public readonly conversationId: string;

  constructor(conversationId: string) {
    super(`Conversation ${conversationId} is busy`);
    this.name = 'ConversationBusyError';
    this.conversationId = conversationId;
  }
}
