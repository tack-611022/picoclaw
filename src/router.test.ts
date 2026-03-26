import { describe, expect, it } from 'vitest';

import { formatMessages, formatOutbound, stripInternalTags } from './router.js';

describe('router formatting', () => {
  it('formats prompt messages as xml context', () => {
    const output = formatMessages(
      [
        {
          id: 'm1',
          sender: 'u1',
          sender_name: 'Alice',
          content: 'Hello <world>',
          timestamp: '2026-03-08T00:00:00.000Z',
        },
      ],
      'UTC',
    );

    expect(output).toContain('<context timezone="UTC" />');
    expect(output).toContain('sender="Alice"');
    expect(output).toContain('Hello &lt;world&gt;');
  });

  it('strips internal tags from outbound text', () => {
    const raw = 'done <internal>secret</internal> visible';
    expect(stripInternalTags(raw)).toBe('done  visible');
    expect(formatOutbound(raw)).toBe('done  visible');
  });
});
