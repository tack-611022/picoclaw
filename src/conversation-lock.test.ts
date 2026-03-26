import { describe, expect, it } from 'vitest';

import {
  ConversationBusyError,
  acquireConversationLock,
  isConversationLocked,
} from './conversation-lock.js';

describe('conversation-lock', () => {
  it('allows sequential access to the same conversation', async () => {
    const release1 = await acquireConversationLock('conv-1');
    expect(isConversationLocked('conv-1')).toBe(true);
    release1();
    expect(isConversationLocked('conv-1')).toBe(false);

    const release2 = await acquireConversationLock('conv-1');
    release2();
  });

  it('allows concurrent access to different conversations', async () => {
    const release1 = await acquireConversationLock('conv-a');
    const release2 = await acquireConversationLock('conv-b');
    expect(isConversationLocked('conv-a')).toBe(true);
    expect(isConversationLocked('conv-b')).toBe(true);
    release1();
    release2();
  });

  it('throws ConversationBusyError when wait=false and locked', async () => {
    const release = await acquireConversationLock('conv-busy');

    await expect(
      acquireConversationLock('conv-busy', { wait: false }),
    ).rejects.toThrow(ConversationBusyError);

    release();
  });

  it('queues when wait=true (default) and locked', async () => {
    const order: number[] = [];
    const release1 = await acquireConversationLock('conv-queue');
    order.push(1);

    const p2 = acquireConversationLock('conv-queue').then((release) => {
      order.push(2);
      release();
    });

    // Give p2 a chance to enqueue
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]); // p2 should be waiting

    release1();
    await p2;
    expect(order).toEqual([1, 2]);
  });
});
