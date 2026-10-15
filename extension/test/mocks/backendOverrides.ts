import { FakeScheduler } from './fakeScheduler';
import { FakeSocketFactory } from './fakeWebSocket';

/**
 * Activation overrides that keep a test off the network and off real timers: opening the panel
 * connects, so every test that opens the panel must supply these. `voiceScheduler` does the same for
 * the voice timers (Task 8.13), kept separate so connection-timer assertions are unaffected.
 */
export function fakeBackendOverrides() {
  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const voiceScheduler = new FakeScheduler();
  return { factory, scheduler, voiceScheduler, overrides: { socketFactory: factory.create, scheduler, voiceScheduler } };
}
