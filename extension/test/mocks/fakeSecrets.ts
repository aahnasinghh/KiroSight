import type { SecretsLike } from '../../src/backend/backendToken';

/** In-memory stand-in for `ExtensionContext.secrets`. Nothing ever touches a real secret store. */
export class FakeSecrets implements SecretsLike {
  public readonly values = new Map<string, string>();
  public readonly calls: Array<{ method: 'get' | 'store' | 'delete'; key: string }> = [];
  public failStore = false;

  public constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  public get(key: string): Promise<string | undefined> {
    this.calls.push({ method: 'get', key });
    return Promise.resolve(this.values.get(key));
  }

  public store(key: string, value: string): Promise<void> {
    this.calls.push({ method: 'store', key });
    if (this.failStore) return Promise.reject(new Error('store failed'));
    this.values.set(key, value);
    return Promise.resolve();
  }

  public delete(key: string): Promise<void> {
    this.calls.push({ method: 'delete', key });
    this.values.delete(key);
    return Promise.resolve();
  }
}
