// Ensure a working localStorage in the jsdom environment for zustand's
// `persist` middleware. Some module-resolution orders can leave the default
// jsdom `localStorage` returning a Storage instance whose methods are not
// bound, which breaks `createJSONStorage(() => localStorage)`. An in-memory
// stub is fully deterministic and isolates persisted state between tests.
import { beforeEach, vi } from 'vitest';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const storage = new MemoryStorage();
vi.stubGlobal('localStorage', storage);

beforeEach(() => {
  storage.clear();
});
