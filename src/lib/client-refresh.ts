/** Fence overlapping reads (poll, data event, explicit refresh) and unmounts. */
export class LatestRead {
  private generation = 0;

  invalidate() {
    ++this.generation;
  }

  async run<T>(read: () => Promise<T>, apply: (value: T) => void) {
    const generation = ++this.generation;
    try {
      const value = await read();
      if (generation !== this.generation) return;
      apply(value);
    } catch (error) {
      if (generation === this.generation) throw error;
    }
  }
}

/** A successful command must not become a failed send because its read failed. */
export async function commitThenRefresh<T>(
  commit: () => Promise<T>,
  refresh: () => Promise<void>,
) {
  const result = await commit();
  try {
    await refresh();
    return { result, refreshFailed: false };
  } catch {
    return { result, refreshFailed: true };
  }
}
