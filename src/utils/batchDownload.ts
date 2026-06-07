import JSZip from 'jszip';
import { openImageDb, IMAGE_STORE_NAME } from './imageDb';
import type { CollectionItem } from '../types/collection';
import type { TaskConfig } from '../types/app';
import type { PersistedGeneratedImage } from '../types/imageTask';
import { getTaskStorageKey } from '../app/storage';
import { loadTaskState } from '../components/imageTaskState';

const isUploadCollectionKey = (key?: string) =>
  Boolean(key && key.startsWith('collection:upload:'));

type CollectedEntry = {
  localKey: string;
  type: 'task' | 'collection';
  refId: string;
  timestamp: number;
  sourceUrl?: string;
};

const collectEntries = async (
  tasks: TaskConfig[],
  collectedItems: CollectionItem[],
): Promise<CollectedEntry[]> => {
  const entries: CollectedEntry[] = [];
  const seenKeys = new Set<string>();

  for (const task of tasks) {
    const state = await loadTaskState(getTaskStorageKey(task.id));
    if (!state) continue;
    const images = Array.isArray(state.generatedImages) ? state.generatedImages : [];
    images.forEach((img: PersistedGeneratedImage) => {
      if (!img.localKey) return;
      if (seenKeys.has(img.localKey)) return;
      seenKeys.add(img.localKey);
      entries.push({
        localKey: img.localKey,
        type: 'task',
        refId: task.id.slice(0, 6),
        timestamp: typeof img.timestamp === 'number' ? img.timestamp : Date.now(),
        sourceUrl: img.sourceUrl,
      });
    });
  }

  collectedItems.forEach((item) => {
    if (!item.localKey) return;
    if (isUploadCollectionKey(item.localKey) || isUploadCollectionKey(item.id)) return;
    if (seenKeys.has(item.localKey)) return;
    seenKeys.add(item.localKey);
    entries.push({
      localKey: item.localKey,
      type: 'collection',
      refId: item.id.slice(0, 6),
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      sourceUrl: item.image,
    });
  });

  return entries;
};

const inferExtension = (mimeType: string): string => {
  const normalized = (mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized.startsWith('image/')) {
    const sub = normalized.split('/')[1];
    if (sub) return sub;
  }
  return 'png';
};

const readImageBlob = async (localKey: string): Promise<Blob | null> => {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openImageDb();
    return await new Promise<Blob | null>((resolve) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      const request = store.get(localKey);
      request.onsuccess = () => {
        const value = request.result as { blob?: Blob } | undefined;
        resolve(value?.blob || null);
      };
      request.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('IndexedDB read failed:', err);
    return null;
  }
};

const fetchSourceBlob = async (sourceUrl?: string): Promise<Blob | null> => {
  if (!sourceUrl) return null;
  if (sourceUrl.startsWith('data:image')) {
    try {
      const res = await fetch(sourceUrl);
      return await res.blob();
    } catch (err) {
      console.warn('data URL blob read failed:', err);
      return null;
    }
  }
  if (!/^https?:\/\//i.test(sourceUrl)) return null;
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) return null;
    return await res.blob();
  } catch (err) {
    console.warn('Fetch source failed:', err);
    return null;
  }
};

export interface BatchDownloadProgress {
  current: number;
  total: number;
}

export interface BatchDownloadResult {
  success: number;
  failed: number;
  total: number;
  errors: string[];
}

export interface BuildBatchDownloadOptions {
  onProgress?: (progress: BatchDownloadProgress) => void;
}

export const buildBatchDownloadZip = async (
  tasks: TaskConfig[],
  collectedItems: CollectionItem[],
  options: BuildBatchDownloadOptions = {},
): Promise<{ blob: Blob; result: BatchDownloadResult } | null> => {
  const entries = await collectEntries(tasks, collectedItems);
  if (entries.length === 0) {
    return null;
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);

  const zip = new JSZip();
  const sourceCounters: Record<string, number> = {};
  const errors: string[] = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    options.onProgress?.({ current: i, total: entries.length });

    let blob = await readImageBlob(entry.localKey);
    if (!blob && entry.sourceUrl) {
      blob = await fetchSourceBlob(entry.sourceUrl);
    }

    if (!blob) {
      failed += 1;
      errors.push(`${entry.localKey}: 无法获取图片数据`);
      continue;
    }

    const ext = inferExtension(blob.type);
    const sourceKey = `${entry.type}-${entry.refId}`;
    sourceCounters[sourceKey] = (sourceCounters[sourceKey] || 0) + 1;
    const idx = sourceCounters[sourceKey];
    const filename = `${entry.timestamp}_${sourceKey}_${idx}.${ext}`;
    zip.file(filename, blob);
    success += 1;
  }

  options.onProgress?.({ current: entries.length, total: entries.length });

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return {
    blob: zipBlob,
    result: { success, failed, total: entries.length, errors },
  };
};

export const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const padTwo = (n: number) => String(n).padStart(2, '0');

export const buildZipFilename = (now: Date = new Date()): string => {
  return `moe-atelier-images-${now.getFullYear()}${padTwo(now.getMonth() + 1)}${padTwo(now.getDate())}-${padTwo(now.getHours())}${padTwo(now.getMinutes())}${padTwo(now.getSeconds())}.zip`;
};
