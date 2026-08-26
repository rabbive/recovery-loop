import { describe, expect, it } from 'vitest';
import { createRecoveryServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('server composition', () => {
  it('runs on a clock that moves, so fallback links can lapse and audit timestamps differ', () => {
    // A pinned clock here would freeze the whole deployment: `expireLapsedFallbackLink` could
    // never fire and every audit event would carry one instant. Time is pinned in tests and in
    // the seeded batch, never in the running app.
    const before = Date.now();

    const { application } = createRecoveryServer(loadConfig({ PORT: '3100' }));

    const now = application.clock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('composes the listener without binding a port', () => {
    const { server } = createRecoveryServer(loadConfig({ PORT: '3100' }));

    expect(server.listening).toBe(false);
  });
});
