import JSZip from 'jszip';
import { openImageDb, IMAGE_STORE_NAME } from './imageDb';
import type { CollectionItem } from '../types/collection';

const HASH_PREFIX_BYTES = 65536;

const computeBlobPrefixHash = async (blob: Blob): Promise<string> => {
  const slice = blob.slice(0, HASH_PREFIX_BYTES);
  const hashBuffer = await crypto.subtle.digest('SHA-256', await slice.arrayBuffer());
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
};

const isUploadCollectionKey = (key?: string) =>
  Boolean(key && key.startsWith('collection:upload:'));

const normalizePrompt = (prompt: string) =>
  prompt.trim().replace(/\s+/g, ' ');

const buildPromptKey = (prompt: string) => {
  const normalized = normalizePrompt(prompt);
  return normalized ? normalized.toLowerCase() : '__empty__';
};

export const sanitizeFilename = (name: string): string => {
  return name.replace(/[:]/g, '-').replace(/[<>:"/\\|?*]/g, '_');
};

export const computeStableId = async (input: string): Promise<string> => {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
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
  lastDownloadTime?: number;
}

export const buildBatchDownloadZip = async (
  collectedItems: CollectionItem[],
  options: BuildBatchDownloadOptions = {},
): Promise<{ blob: Blob; result: BatchDownloadResult } | null> => {
  const lastDownloadTime = options.lastDownloadTime;
  const groups = new Map<string, { prompt: string; items: CollectionItem[] }>();

  for (const item of collectedItems) {
    if (!item.localKey) continue;
    if (isUploadCollectionKey(item.localKey) || isUploadCollectionKey(item.id)) continue;
    const ts = typeof item.timestamp === 'number' ? item.timestamp : Date.now();
    if (lastDownloadTime !== undefined && ts <= lastDownloadTime) continue;

    const key = buildPromptKey(item.prompt || '');
    let group = groups.get(key);
    if (!group) {
      group = { prompt: item.prompt || '', items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }

  if (groups.size === 0) return null;

  const groupList = Array.from(groups.entries())
    .map(([key, g]) => ({ key, prompt: g.prompt, items: g.items }))
    .sort((a, b) => {
      const aTs = a.items.reduce((m, i) => Math.max(m, i.timestamp), 0);
      const bTs = b.items.reduce((m, i) => Math.max(m, i.timestamp), 0);
      return bTs - aTs;
    });

  const zip = new JSZip();
  const errors: string[] = [];
  const seenHashes = new Set<string>();
  let success = 0;
  let failed = 0;
  let totalItems = 0;
  groupList.forEach((g) => { totalItems += g.items.length; });
  let processed = 0;

  for (const group of groupList) {
    const dirName = await computeStableId(group.prompt);
    const dir = zip.folder(dirName);
    if (!dir) continue;

    dir.file('prompt.txt', group.prompt || '');

    for (const item of group.items) {
      options.onProgress?.({ current: processed, total: totalItems });

      let blob = await readImageBlob(item.localKey!);
      if (!blob && item.image) {
        blob = await fetchSourceBlob(item.image);
      }

      if (!blob) {
        failed += 1;
        errors.push(`${item.localKey}: 无法获取图片数据`);
        processed += 1;
        continue;
      }

      const hash = await computeBlobPrefixHash(blob);
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        const ext = inferExtension(blob.type);
        const filename = `${sanitizeFilename(item.localKey!)}.${ext}`;
        dir.file(filename, blob);
        success += 1;
      }

      processed += 1;
    }
  }

  options.onProgress?.({ current: totalItems, total: totalItems });

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return {
    blob: zipBlob,
    result: { success, failed, total: totalItems, errors },
  };
};

export const buildGroupDownloadZip = async (
  items: CollectionItem[],
  prompt: string,
): Promise<Blob | null> => {
  const generatedItems = items.filter(
    (item) => !isUploadCollectionKey(item.localKey) && !isUploadCollectionKey(item.id),
  );
  if (generatedItems.length === 0) return null;

  const zip = new JSZip();

  zip.file('prompt.txt', prompt || '');

  for (const item of generatedItems) {
    let blob: Blob | null = null;
    if (item.localKey) {
      blob = await readImageBlob(item.localKey);
    }
    if (!blob && item.image) {
      blob = await fetchSourceBlob(item.image);
    }
    if (!blob) continue;

    const ext = inferExtension(blob.type);
    const filename = `${sanitizeFilename(item.localKey || item.id)}.${ext}`;
    zip.file(filename, blob);
  }

  return await zip.generateAsync({ type: 'blob' });
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
  return `moe-atelier-${now.getFullYear()}${padTwo(now.getMonth() + 1)}${padTwo(now.getDate())}-${padTwo(now.getHours())}${padTwo(now.getMinutes())}${padTwo(now.getSeconds())}.zip`;
};
