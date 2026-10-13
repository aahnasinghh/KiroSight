import { FakeScheduler } from './fakeScheduler';
import { FakeSocketFactory } from './fakeWebSocket';

/**
 * Activation overrides that keep a test off the network and off real timers: opening the panel
 * connects, so every test that opens the panel must supply these.
 */
export function fakeBackendOverrides() {
  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  return { factory, scheduler, overrides: { socketFactory: factory.create, scheduler } };
}
