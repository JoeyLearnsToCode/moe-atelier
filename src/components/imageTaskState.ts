import type {
  PersistedImageTaskState,
  PersistedSubTaskResult,
  SubTaskResult,
} from '../types/imageTask';
import type { TaskStats } from '../types/stats';
import { safeStorageGet, safeStorageRemove } from '../utils/storage';
import { openImageDb, TASK_STATE_STORE_NAME } from '../utils/imageDb';

export const TASK_STATE_VERSION = 1;

export const DEFAULT_TASK_STATS: TaskStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};

const idbGetTaskState = async (storageKey: string): Promise<PersistedImageTaskState | null> => {
  try {
    const db = await openImageDb();
    return await new Promise<PersistedImageTaskState | null>((resolve) => {
      const tx = db.transaction(TASK_STATE_STORE_NAME, 'readonly');
      const request = tx.objectStore(TASK_STATE_STORE_NAME).get(storageKey);
      request.onsuccess = () => {
        const data = request.result as PersistedImageTaskState | undefined;
        if (!data || data.version !== TASK_STATE_VERSION) {
          resolve(null);
          return;
        }
        resolve(data);
      };
      request.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('Failed to read task state from IndexedDB:', err);
    return null;
  }
};

const idbSetTaskState = async (storageKey: string, state: PersistedImageTaskState) => {
  try {
    const db = await openImageDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(TASK_STATE_STORE_NAME, 'readwrite');
      tx.objectStore(TASK_STATE_STORE_NAME).put(state, storageKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to write task state to IndexedDB:', err);
  }
};

const migrateFromLocalStorage = async (
  storageKey: string,
): Promise<PersistedImageTaskState | null> => {
  const raw = safeStorageGet(storageKey, 'task cache');
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedImageTaskState;
    if (!data || data.version !== TASK_STATE_VERSION) {
      safeStorageRemove(storageKey, 'task cache');
      return null;
    }
    await idbSetTaskState(storageKey, data);
    safeStorageRemove(storageKey, 'task cache');
    return data;
  } catch (err) {
    console.warn('Failed to migrate task cache from localStorage:', err);
    safeStorageRemove(storageKey, 'task cache');
    return null;
  }
};

export const loadTaskState = async (
  storageKey: string,
): Promise<PersistedImageTaskState | null> => {
  const fromIdb = await idbGetTaskState(storageKey);
  if (fromIdb) return fromIdb;
  return migrateFromLocalStorage(storageKey);
};

export const saveTaskState = async (storageKey: string, state: PersistedImageTaskState) => {
  await idbSetTaskState(storageKey, state);
};

export const serializeResults = (results: SubTaskResult[]): PersistedSubTaskResult[] =>
  results.map((result: SubTaskResult) => {
    const sourceUrl =
      result.sourceUrl ||
      (result.displayUrl && !result.displayUrl.startsWith('blob:')
        ? result.displayUrl
        : undefined);
    const shouldStoreSource =
      !sourceUrl ||
      !sourceUrl.startsWith('data:image') ||
      !result.localKey;
    return {
      id: result.id,
      status: result.status,
      error: result.error,
      autoRetry: result.autoRetry,
      retryCount: result.retryCount,
      startTime: result.startTime,
      endTime: result.endTime,
      duration: result.duration,
      localKey: result.localKey,
      sourceUrl: shouldStoreSource ? sourceUrl : undefined,
      savedLocal: result.savedLocal,
    };
  });
