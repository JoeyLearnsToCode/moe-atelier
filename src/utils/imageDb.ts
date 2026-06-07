export const IMAGE_DB_NAME = 'moe-image-cache';
export const IMAGE_STORE_NAME = 'images';
export const TASK_STATE_STORE_NAME = 'taskStates';
export const IMAGE_DB_VERSION = 2;

export const openImageDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const request = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        db.createObjectStore(IMAGE_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(TASK_STATE_STORE_NAME)) {
        db.createObjectStore(TASK_STATE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
