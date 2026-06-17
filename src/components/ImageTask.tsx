import React, { useState, useRef, useEffect } from 'react';
import { 
  Input, Button, Upload, message, Spin, Image, 
  Space, Typography, Tooltip, Popover, InputNumber, Select
} from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { 
  UploadOutlined, DeleteFilled, ReloadOutlined, 
  BellFilled, BellOutlined, DownloadOutlined, PictureFilled,
  CloseCircleFilled, PauseCircleFilled, FireFilled,
  StarFilled,
  LoadingOutlined,
  PlayCircleFilled,
  HolderOutlined,
  CloudUploadOutlined,
  SettingFilled
} from '@ant-design/icons';
import type { RcFile, UploadFile } from 'antd/es/upload/interface';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig } from '../types/app';
import type { TaskStats } from '../types/stats';
import type {
  PersistedImageTaskState,
  PersistedSubTaskResult,
  SubTaskResult,
  PersistedUploadImage,
  GeneratedImageEntry,
} from '../types/imageTask';
import type { CollectionItem } from '../types/collection';
import type { LogEntry } from '../types/log';
import { DEFAULT_TASK_STATS, loadTaskState, saveTaskState, serializeResults, TASK_STATE_VERSION } from './imageTaskState';
import { getBase64 } from '../utils/file';
import { parseMarkdownImage, resolveImageFromResponse } from '../utils/imageResponse';
import { openImageDb, IMAGE_STORE_NAME } from '../utils/imageDb';
import {
  extractVertexProjectId,
  inferApiVersionFromUrl,
  normalizeApiBase,
  resolveApiUrl,
  resolveApiVersion,
} from '../utils/apiUrl';
import { calculateSuccessRate, formatDuration } from '../utils/stats';
import { buildPromptKey } from '../utils/prompt';

import {
  formatResponseErrorMessage,
  formatUnknownErrorMessage,
} from '../utils/httpError';
import { useInputGuard } from '../utils/inputSync';
import PrivacyBlur from './PrivacyBlur';

const { Text } = Typography;
const { TextArea } = Input;

interface ImageTaskProps {
  id: string;
  storageKey: string;
  config: AppConfig;
  onRemove: () => void;
  onStatsUpdate: (type: 'request' | 'success' | 'fail', duration?: number) => void;
  onCollect?: (item: CollectionItem) => void;
  onLog?: (entry: LogEntry) => void;
  collectionRevision?: number;
  dragAttributes?: any;
  dragListeners?: any;
}
const SUCCESS_AUDIO_SRC = 'https://actions.google.com/sounds/v1/cartoon/magic_chime.ogg';
const DEFAULT_CONCURRENCY = 2;

type UploadFileWithMeta = UploadFile & {
  localKey?: string;
  lastModified?: number;
  fromCollection?: boolean;
  sourceSignature?: string;
};

type CollectionUploadSnapshot = {
  uploadKey: string;
  sourceLocalKey?: string;
  sourceBlob?: Blob;
  sourceUrl?: string;
  sourceSignature?: string;
};

type CollectionRequestSnapshot = {
  prompt: string;
  uploads: CollectionUploadSnapshot[];
};

const normalizeStoredResult = (item: PersistedSubTaskResult): SubTaskResult => {
  const wasLoading = item.status === 'loading' || item.status === 'pending';
  const inferredAutoRetry =
    typeof item.autoRetry === 'boolean'
      ? item.autoRetry
      : wasLoading || Boolean(item.error?.includes('后重试...'));
  return {
    id: item.id,
    status: item.status,
    error: item.error,
    autoRetry: inferredAutoRetry,
    retryCount: typeof item.retryCount === 'number' ? item.retryCount : 0,
    startTime: item.startTime,
    endTime: item.endTime,
    duration: item.duration,
    localKey: item.localKey,
    sourceUrl: item.sourceUrl,
    savedLocal: item.savedLocal,
    displayUrl: item.localKey ? undefined : item.sourceUrl,
  };
};

const serializeUploads = (uploads: UploadFileWithMeta[]): PersistedUploadImage[] =>
  uploads
    .filter((file) => file.localKey)
    .map((file) => ({
      uid: file.uid,
      name: file.name,
      type: file.type || file.originFileObj?.type,
      size: file.size ?? file.originFileObj?.size,
      lastModified: file.lastModified ?? file.originFileObj?.lastModified,
      localKey: file.localKey as string,
      fromCollection: file.fromCollection,
      sourceSignature: file.sourceSignature,
    }));

const normalizeConcurrency = (value: unknown, fallback = DEFAULT_CONCURRENCY) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
};

const ImageTask: React.FC<ImageTaskProps> = ({ id, storageKey, config, onRemove, onStatsUpdate, onCollect, onLog, collectionRevision, dragAttributes, dragListeners }: ImageTaskProps) => {
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef(prompt);
  const promptFocusedRef = useRef(false);
  const promptTextareaRef = useRef<TextAreaRef | null>(null);
  const stickyNoteWrapRef = useRef<HTMLDivElement | null>(null);
  const [fileList, setFileList] = useState<UploadFileWithMeta[]>([]);
  const fileListRef = useRef<UploadFileWithMeta[]>(fileList);
  const [concurrency, setConcurrency] = useState<number>(DEFAULT_CONCURRENCY);
  const [concurrencyInput, setConcurrencyInput] = useState<string>(String(DEFAULT_CONCURRENCY));
  const [enableSound, setEnableSound] = useState<boolean>(true);
  const [retryInterval, setRetryInterval] = useState<number>(1000);
  const [retryLimit, setRetryLimit] = useState<number>(-1);
  const [generationCount, setGenerationCount] = useState<number>(1);
  const retryIntervalRef = useRef(retryInterval);
  const retryLimitRef = useRef(retryLimit);
  const generationCountRef = useRef(generationCount);
  const [apiProfileId, setApiProfileId] = useState<string>('default');
  const apiProfileIdRef = useRef(apiProfileId);
  
  const [results, setResults] = useState<SubTaskResult[]>([]);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImageEntry[]>([]);
  const [isGlobalLoading, setIsGlobalLoading] = useState(false);
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const [stats, setStats] = useState<TaskStats>({ ...DEFAULT_TASK_STATS });
  const [hydrated, setHydrated] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const isRetryingRef = useRef<Map<string, boolean>>(new Map());
  const taskDoneRef = useRef(false);
  const runSuccessCountRef = useRef(0);
  const taskStartTimesRef = useRef<Map<string, number>>(new Map());
  const retryTimersRef = useRef<Map<string, number>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevResultsRef = useRef<SubTaskResult[]>([]);
  const dbPromiseRef = useRef<Promise<IDBDatabase> | null>(null);
  const objectUrlMapRef = useRef<Map<string, string>>(new Map());
  const uploadKeysRef = useRef<Map<string, string>>(new Map());
  const cachedUploadKeysRef = useRef<Set<string>>(new Set());
  const collectedCollectionKeysRef = useRef<Set<string>>(new Set());
  const requestContextByResultIdRef = useRef<Map<string, CollectionRequestSnapshot>>(new Map());
  const lastCollectionRevisionRef = useRef(collectionRevision);
  const retrySettingsRef = useRef({ interval: retryInterval, limit: retryLimit });
  const generationEpochRef = useRef(0);
  const [genPreviewIndex, setGenPreviewIndex] = useState(0);
  const [previewVisible, setPreviewVisible] = useState(false);
  const genPreviewIndexRef = useRef(0);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const galleryRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { genPreviewIndexRef.current = genPreviewIndex; }, [genPreviewIndex]);
  useEffect(() => {
    retrySettingsRef.current = { interval: retryInterval, limit: retryLimit };
  }, [retryInterval, retryLimit]);
  const currentResultsRef = useRef<SubTaskResult[]>(results);
  useEffect(() => {
    currentResultsRef.current = results;
  }, [results]);
  const promptGuard = useInputGuard({ isEditing: () => promptFocusedRef.current });
  const retryIntervalGuard = useInputGuard();
  const retryLimitGuard = useInputGuard();
  const generationCountGuard = useInputGuard();
  const apiProfileGuard = useInputGuard();
  const { markDirty: markPromptDirty } = promptGuard;
  const { markDirty: markRetryIntervalDirty } = retryIntervalGuard;
  const { markDirty: markRetryLimitDirty } = retryLimitGuard;
  const { markDirty: markGenerationCountDirty } = generationCountGuard;
  const { markDirty: markApiProfileDirty } = apiProfileGuard;

  const resolveTaskApiProfileId = (value?: string) => {
    const availableProfiles = config.apiProfiles || [{ id: 'default', name: '默认配置' }];
    const fallbackProfileId = config.activeApiProfileId || availableProfiles[0]?.id || 'default';
    if (!value) return fallbackProfileId;
    return availableProfiles.some((profile) => profile.id === value) ? value : fallbackProfileId;
  };

  useEffect(() => {
    let isActive = true;
    const hydrate = async () => {
      const stored = await loadTaskState(storageKey);
      if (stored) {
        setPrompt(stored.prompt ?? '');
        const nextConcurrency = normalizeConcurrency(stored.concurrency, DEFAULT_CONCURRENCY);
        setConcurrency(nextConcurrency);
        setConcurrencyInput(String(nextConcurrency));
        setEnableSound(typeof stored.enableSound === 'boolean' ? stored.enableSound : true);
        setRetryInterval(typeof stored.retryInterval === 'number' ? stored.retryInterval : 1000);
        setRetryLimit(typeof stored.retryLimit === 'number' ? stored.retryLimit : -1);
        setGenerationCount(typeof stored.generationCount === 'number' ? stored.generationCount : 1);
        setApiProfileId(resolveTaskApiProfileId(stored.apiProfileId));
        setStats({ ...DEFAULT_TASK_STATS, ...(stored.stats || {}) });
        const storedResults = Array.isArray(stored.results) ? stored.results : [];
        const hydratedResults: SubTaskResult[] = [];
        for (const item of storedResults) {
          const normalized = normalizeStoredResult(item);
          if (normalized.localKey) {
            const blob = await getImageBlob(normalized.localKey);
            if (blob) {
              const objectUrl = URL.createObjectURL(blob);
              normalized.displayUrl = objectUrl;
              registerObjectUrl(normalized.id, objectUrl);
            } else if (normalized.sourceUrl) {
              normalized.displayUrl = normalized.sourceUrl;
            }
          } else if (normalized.sourceUrl) {
            normalized.displayUrl = normalized.sourceUrl;
          }
          hydratedResults.push(normalized);
        }
        if (isActive) {
          currentResultsRef.current = hydratedResults;
          setResults(hydratedResults);
        }
        const storedUploads = Array.isArray(stored.uploads) ? stored.uploads : [];
        if (storedUploads.length > 0) {
          const hydratedUploads: UploadFileWithMeta[] = [];
          for (const item of storedUploads) {
            if (!item?.localKey) continue;
            const blob = await getImageBlob(item.localKey);
            if (!blob) continue;
            const rawFile = new File([blob], item.name, {
              type: item.type || blob.type || 'application/octet-stream',
              lastModified: item.lastModified || Date.now(),
            });
            const rcFile = rawFile as RcFile;
            const objectUrl = URL.createObjectURL(blob);
            registerObjectUrl(item.localKey, objectUrl);
            cachedUploadKeysRef.current.add(item.localKey);
            const signature =
              item.sourceSignature ||
              buildUploadSignature({
                uid: item.uid,
                name: item.name,
                size: item.size ?? rcFile.size,
                lastModified: item.lastModified ?? rcFile.lastModified,
                type: item.type ?? rcFile.type,
              } as UploadFileWithMeta);
            hydratedUploads.push({
              uid: item.uid,
              name: item.name,
              status: 'done',
              size: item.size ?? rcFile.size,
              type: item.type ?? rcFile.type,
              lastModified: item.lastModified ?? rcFile.lastModified,
              originFileObj: rcFile,
              thumbUrl: objectUrl,
              localKey: item.localKey,
              fromCollection: item.fromCollection,
              sourceSignature: signature || item.sourceSignature,
            });
          }
          if (isActive) {
            setFileList(hydratedUploads);
          }
        }
        const persistedImages = Array.isArray(stored.generatedImages) ? stored.generatedImages : [];
        if (persistedImages.length > 0) {
          const hydratedImages: GeneratedImageEntry[] = [];
          for (const item of persistedImages) {
            if (!item?.localKey && !item?.sourceUrl) continue;
            let displayUrl: string | undefined;
            if (item.localKey) {
              const blob = await getImageBlob(item.localKey);
              if (blob) {
                const objectUrl = URL.createObjectURL(blob);
                displayUrl = objectUrl;
                registerObjectUrl(item.id, objectUrl);
              }
            }
            if (!displayUrl && item.sourceUrl) {
              displayUrl = item.sourceUrl;
            }
            if (displayUrl) {
              hydratedImages.push({
                id: item.id,
                displayUrl,
                localKey: item.localKey,
                sourceUrl: item.sourceUrl,
                timestamp: item.timestamp,
              });
            }
          }
          if (isActive) {
            setGeneratedImages(hydratedImages);
          }
        }
      }
      if (isActive) {
        setHydrated(true);
      }
    };
    void hydrate();
    return () => {
      isActive = false;
    };
  }, [storageKey, id]);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    retryIntervalRef.current = retryInterval;
  }, [retryInterval]);

  useEffect(() => {
    retryLimitRef.current = retryLimit;
  }, [retryLimit]);

  useEffect(() => {
    generationCountRef.current = generationCount;
  }, [generationCount]);

  useEffect(() => {
    apiProfileIdRef.current = apiProfileId;
  }, [apiProfileId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      syncStickyNoteScroll();
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [prompt, hydrated]);

  useEffect(() => {
    fileListRef.current = fileList;
  }, [fileList]);

  useEffect(() => {
    audioRef.current = new Audio(SUCCESS_AUDIO_SRC);
    return () => {
      abortControllersRef.current.forEach((controller: AbortController) => controller.abort());
      retryTimersRef.current.forEach((timerId: number) => clearTimeout(timerId));
      retryTimersRef.current.clear();
      objectUrlMapRef.current.forEach((url: string) => URL.revokeObjectURL(url));
      objectUrlMapRef.current.clear();
      taskStartTimesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const payload: PersistedImageTaskState = {
      version: TASK_STATE_VERSION,
      prompt,
      concurrency,
      enableSound,
      retryInterval,
      retryLimit,
      generationCount,
      results: serializeResults(results),
      uploads: serializeUploads(fileList),
      generatedImages: generatedImages.map(img => ({
        id: img.id,
        localKey: img.localKey,
        sourceUrl: img.sourceUrl,
        timestamp: img.timestamp,
      })),
      stats,
      apiProfileId,
    };
    saveTaskState(storageKey, payload).catch((err) =>
      console.warn('Failed to persist task state:', err),
    );
  }, [prompt, concurrency, enableSound, retryInterval, retryLimit, generationCount, results, generatedImages, stats, storageKey, hydrated, fileList, apiProfileId]);

  useEffect(() => {
    const previous = prevResultsRef.current;
    prevResultsRef.current = results;
    if (!enableSound) return;
    if (previous.length === 0) return;
    const previousStatus = new Map(previous.map((item) => [item.id, item.status]));
    const hasNewSuccess = results.some(
      (item) => item.status === 'success' && previousStatus.get(item.id) !== 'success',
    );
    if (hasNewSuccess) {
      playSuccessSound();
    }
  }, [results, enableSound]);

  useEffect(() => {
    if (!isGlobalLoading) return;
    setElapsedNow(Date.now());
    const id = window.setInterval(() => {
      setElapsedNow(Date.now());
    }, 5000);
    return () => window.clearInterval(id);
  }, [isGlobalLoading]);

  useEffect(() => {
    collectedCollectionKeysRef.current.clear();
    requestContextByResultIdRef.current.clear();
  }, [id]);

  useEffect(() => {
    if (collectionRevision === undefined) return;
    if (lastCollectionRevisionRef.current === collectionRevision) return;
    lastCollectionRevisionRef.current = collectionRevision;
    Array.from(collectedCollectionKeysRef.current).forEach((key) => {
      if (key.startsWith('collection:upload:') || key.startsWith('upload:')) {
        collectedCollectionKeysRef.current.delete(key);
      }
    });
  }, [collectionRevision]);

  useEffect(() => {
    if (!hydrated) return;
    let isActive = true;
    const persistUploads = async () => {
      const pending = fileList.filter(
        (file) => file.originFileObj && file.localKey && !cachedUploadKeysRef.current.has(file.localKey),
      );
      if (pending.length === 0) return;
      try {
        await Promise.all(
          pending.map(async (file) => {
            const localKey = file.localKey as string;
            await saveImageBlob(localKey, file.originFileObj as File);
            cachedUploadKeysRef.current.add(localKey);
          }),
        );
        if (!isActive) return;
      } catch (err) {
        console.warn('上传图片缓存失败:', err);
      }
    };
    void persistUploads();
    return () => {
      isActive = false;
    };
  }, [fileList, hydrated]);

  useEffect(() => {
    const nextKeys = new Map<string, string>();
    fileList.forEach((file) => {
      const key = file.localKey || buildUploadKey(file.uid);
      nextKeys.set(file.uid, key);
    });
    uploadKeysRef.current.forEach((key, uid) => {
      const nextKey = nextKeys.get(uid);
      if (!nextKey) {
        clearObjectUrl(key);
        cachedUploadKeysRef.current.delete(key);
        if (!isCollectionCacheKey(key)) {
          void deleteImageBlob(key);
        }
        return;
      }
      if (nextKey !== key) {
        clearObjectUrl(key);
        cachedUploadKeysRef.current.delete(key);
      }
    });
    uploadKeysRef.current = nextKeys;
  }, [fileList]);

  const playSuccessSound = () => {
    if (enableSound && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch((e: any) => console.error('Error playing sound:', e));
    }
  };

  const handlePromptChange = (value: string) => {
    markPromptDirty();
    promptRef.current = value;
    setPrompt(value);
  };

  const handleRetryIntervalChange = (value: number | null) => {
    const nextRetryInterval = Math.max(0, value || 0) * 1000;
    markRetryIntervalDirty();
    retryIntervalRef.current = nextRetryInterval;
    setRetryInterval(nextRetryInterval);
  };

  const handleRetryLimitChange = (value: number | null) => {
    const nextRetryLimit = typeof value === 'number' ? Math.max(-1, Math.floor(value)) : -1;
    markRetryLimitDirty();
    retryLimitRef.current = nextRetryLimit;
    setRetryLimit(nextRetryLimit);
  };

  const handleGenerationCountChange = (value: number | null) => {
    const nextGenerationCount = Math.max(1, Math.floor(value || 1));
    markGenerationCountDirty();
    generationCountRef.current = nextGenerationCount;
    setGenerationCount(nextGenerationCount);
  };

  const handleApiProfileChange = (value: string) => {
    const nextApiProfileId = resolveTaskApiProfileId(value);
    markApiProfileDirty();
    apiProfileIdRef.current = nextApiProfileId;
    setApiProfileId(nextApiProfileId);
  };

  function syncStickyNoteScroll() {
    const wrap = stickyNoteWrapRef.current;
    const textarea = promptTextareaRef.current?.resizableTextArea?.textArea;
    if (!wrap || !textarea) return;
    wrap.style.setProperty('--sticky-note-scroll-top', `${textarea.scrollTop}px`);
  }

  const handlePromptFocus = () => {
    promptFocusedRef.current = true;
  };

  const handlePromptBlur = () => {
    promptFocusedRef.current = false;
  };

  const resolveImageExtension = (mimeType: string) => {
    const normalized = mimeType.toLowerCase();
    if (normalized === 'image/jpeg') return 'jpg';
    if (normalized === 'image/png') return 'png';
    if (normalized === 'image/webp') return 'webp';
    if (normalized === 'image/gif') return 'gif';
    if (normalized.startsWith('image/')) return normalized.split('/')[1];
    return 'png';
  };

  const handlePromptPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const imageFiles: File[] = [];
    Array.from(clipboard.items || []).forEach((item) => {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    });
    if (imageFiles.length === 0 && clipboard.files?.length) {
      Array.from(clipboard.files).forEach((file) => {
        if (file.type.startsWith('image/')) {
          imageFiles.push(file);
        }
      });
    }
    if (imageFiles.length === 0) return;
    event.preventDefault();

    const timestamp = Date.now();
    const uploads: UploadFile[] = imageFiles.map((file, index) => {
      const mimeType = file.type || 'image/png';
      const extension = resolveImageExtension(mimeType);
      const normalized = new File(
        [file],
        `paste-${timestamp}-${index + 1}.${extension}`,
        { type: mimeType, lastModified: timestamp },
      );
      return {
        uid: uuidv4(),
        name: normalized.name,
        status: 'done',
        originFileObj: normalized as RcFile,
        type: normalized.type,
        size: normalized.size,
        lastModified: normalized.lastModified,
      };
    });

    handleUploadChange({ fileList: [...fileList, ...uploads] });
  };

  const handleConcurrencyInputChange = (value: string) => {
    if (value === '') {
      setConcurrencyInput('');
      return;
    }
    if (!/^\d+$/.test(value)) return;
    const parsed = Number(value);
    const normalized = Math.max(1, parsed);
    setConcurrencyInput(value);
    setConcurrency(normalized);
  };

  const handleConcurrencyInputBlur = () => {
    if (concurrencyInput === '') {
      setConcurrencyInput(String(concurrency));
      return;
    }
    if (!/^\d+$/.test(concurrencyInput)) {
      setConcurrencyInput(String(concurrency));
      return;
    }
    const parsed = Number(concurrencyInput);
    const normalized = Math.max(1, parsed);
    const normalizedValue = String(normalized);
    if (normalizedValue !== concurrencyInput) {
      setConcurrencyInput(normalizedValue);
    }
    if (normalized !== concurrency) {
      setConcurrency(normalized);
    }
  };

  const buildUploadKey = (uid: string) => `${storageKey}:upload:${uid}`;
  const buildResultCollectionKey = (subTaskId: string, endTime: number) =>
    `collection:result:${subTaskId}:${endTime}`;
  const buildUploadCollectionKey = (taskId: string, uploadKey: string) =>
    `collection:upload:${taskId}:${uploadKey}`;
  const buildUploadSignature = (file: UploadFileWithMeta) => {
    const name = typeof file.name === 'string' ? file.name : '';
    const size = file.size ?? file.originFileObj?.size;
    const lastModified = file.lastModified ?? file.originFileObj?.lastModified;
    const type = file.type ?? file.originFileObj?.type;
    if (!name || typeof size !== 'number' || typeof lastModified !== 'number') {
      return '';
    }
    return `${name}:${size}:${lastModified}:${type || ''}`;
  };
  const isCollectionCacheKey = (key?: string) =>
    Boolean(key && key.startsWith('collection:'));
  const buildCollectionRequestSnapshot = (requestPrompt: string): CollectionRequestSnapshot => {
    const uploads: CollectionUploadSnapshot[] = [];
    fileList.forEach((file) => {
      const uploadKey = file.uid || file.localKey;
      if (!uploadKey) return;

      const signature = file.sourceSignature || buildUploadSignature(file);
      const sourceBlob = file.originFileObj as Blob | undefined;
      const sourceUrl = typeof file.thumbUrl === 'string' ? file.thumbUrl : undefined;
      const sourceLocalKey = file.localKey;
      if (!sourceBlob && !sourceLocalKey && !sourceUrl) return;
      uploads.push({
        uploadKey,
        sourceLocalKey,
        sourceBlob,
        sourceUrl,
        sourceSignature: signature || undefined,
      });
    });
    return { prompt: requestPrompt, uploads };
  };
  const buildUploadCollectionDedupeKey = (
    requestPrompt: string,
    upload: CollectionUploadSnapshot,
    collectionKey: string,
  ) => {
    const promptKey = buildPromptKey(requestPrompt);
    if (upload.sourceSignature) {
      return `upload:${promptKey}:${upload.sourceSignature}`;
    }
    return `upload:${promptKey}:${upload.uploadKey || collectionKey}`;
  };

  const getImageDb = () => {
    if (typeof indexedDB === 'undefined') return null;
    if (!dbPromiseRef.current) {
      dbPromiseRef.current = openImageDb();
    }
    return dbPromiseRef.current;
  };

  const saveImageBlob = async (key: string, blob: Blob) => {
    const dbPromise = getImageDb();
    if (!dbPromise) return;
    const db = await dbPromise;
    await new Promise<void>((resolve, reject) => {
      const now = Date.now();
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      tx.objectStore(IMAGE_STORE_NAME).put({ blob, createdAt: now }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  const getImageBlob = async (key: string): Promise<Blob | null> => {
    const dbPromise = getImageDb();
    if (!dbPromise) return null;
    const db = await dbPromise;
    return await new Promise<Blob | null>((resolve) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const value = request.result as { blob?: Blob } | undefined;
        if (!value?.blob) {
          resolve(null);
          return;
        }
        resolve(value.blob);
      };
      request.onerror = () => resolve(null);
    });
  };

  const deleteImageBlob = async (key: string) => {
    const dbPromise = getImageDb();
    if (!dbPromise) return;
    try {
      const db = await dbPromise;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
        tx.objectStore(IMAGE_STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('Failed to remove cached image:', err);
    }
  };

  const fetchImageBlob = async (sourceUrl: string): Promise<Blob | null> => {
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) return null;
      return await response.blob();
    } catch (err) {
      console.warn('读取图片数据失败:', err);
      return null;
    }
  };

  const collectImageForCollection = async (options: {
    collectionKey: string;
    dedupeKey?: string;
    sourceUrl?: string;
    sourceLocalKey?: string;
    sourceBlob?: Blob;
    sourceSignature?: string;
    prompt: string;
    timestamp: number;
    taskId: string;
  }) => {
    if (!config.enableCollection || !onCollect) return;
    const dedupeKey = options.dedupeKey || options.collectionKey;
    if (collectedCollectionKeysRef.current.has(dedupeKey)) return;

    collectedCollectionKeysRef.current.add(dedupeKey);
    let blob: Blob | null = null;
    if (options.sourceBlob) {
      blob = options.sourceBlob;
    } else if (options.sourceLocalKey) {
      blob = await getImageBlob(options.sourceLocalKey);
    }
    if (!blob && options.sourceUrl) {
      blob = await fetchImageBlob(options.sourceUrl);
    }

    let localKey: string | undefined;
    if (blob) {
      await saveImageBlob(options.collectionKey, blob);
      localKey = options.collectionKey;
    }

    onCollect({
      id: localKey || options.collectionKey,
      prompt: options.prompt,
      image: options.sourceUrl,
      timestamp: options.timestamp,
      taskId: options.taskId,
      localKey,
      sourceSignature: options.sourceSignature,
    });
  };

  const collectReferenceImagesForCollection = (snapshot: CollectionRequestSnapshot) => {
    if (!config.enableCollection || !onCollect) return;
    if (snapshot.uploads.length === 0) return;
    snapshot.uploads.forEach((upload) => {
      const collectionKey = buildUploadCollectionKey(id, upload.uploadKey);
      const dedupeKey = buildUploadCollectionDedupeKey(
        snapshot.prompt,
        upload,
        collectionKey,
      );
      void collectImageForCollection({
        collectionKey,
        dedupeKey,
        sourceBlob: upload.sourceBlob,
        sourceLocalKey: upload.sourceLocalKey,
        sourceUrl: upload.sourceUrl,
        sourceSignature: upload.sourceSignature,
        prompt: snapshot.prompt,
        timestamp: Date.now(),
        taskId: id,
      });
    });
  };

  const apiMarkerSegments = new Set(['projects', 'locations', 'publishers', 'models']);
  const apiVersionPattern = /^v1(?:beta1|beta)?$/i;
  const isVersionSegment = (value?: string) =>
    Boolean(value && apiVersionPattern.test(value));

  const normalizeBase64Payload = (value: string) => value.replace(/\s+/g, '');
  const clampNumber = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));

  const splitDataUrl = (value: string) => {
    const match = value.match(/^data:(.+?);base64,(.*)$/i);
    if (!match) {
      return { mimeType: '', data: normalizeBase64Payload(value) };
    }
    return { mimeType: match[1], data: normalizeBase64Payload(match[2]) };
  };

  const resolveWebpQuality = (profile: any) => {
    if (typeof profile.webpQuality !== 'number' || Number.isNaN(profile.webpQuality)) {
      return null;
    }
    return clampNumber(Math.round(profile.webpQuality), 50, 100);
  };

  const convertDataUrlToWebp = (dataUrl: string, quality: number) =>
    new Promise<{ mimeType: string; data: string }>((resolve, reject) => {
      const img = document.createElement('img');
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas context is unavailable'));
            return;
          }
          ctx.drawImage(img, 0, 0);
          const webpDataUrl = canvas.toDataURL('image/webp', quality);
          const parts = webpDataUrl.split(';base64,');
          if (parts.length !== 2) {
            reject(new Error('Unexpected WebP data URL format'));
            return;
          }
          resolve({
            mimeType: parts[0].split(':')[1] || 'image/webp',
            data: parts[1],
          });
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Failed to decode image for WebP conversion'));
      img.src = dataUrl;
    });

  const maybeConvertToWebp = async (dataUrl: string, profile: any) => {
    const { mimeType, data } = splitDataUrl(dataUrl);
    const normalized = normalizeBase64Payload(data);
    if (!mimeType || mimeType.toLowerCase() === 'image/webp') {
      return { mimeType: mimeType || 'image/png', data: normalized };
    }
    const quality = resolveWebpQuality(profile);
    if (!quality) {
      return { mimeType: mimeType || 'image/png', data: normalized };
    }
    try {
      const webp = await convertDataUrlToWebp(
        `data:${mimeType};base64,${normalized}`,
        clampNumber(quality / 100, 0.1, 1),
      );
      return {
        mimeType: webp.mimeType,
        data: normalizeBase64Payload(webp.data),
      };
    } catch (err) {
      console.warn('WebP conversion failed, using original image.', err);
      return { mimeType: mimeType || 'image/png', data: normalized };
    }
  };

  const buildGeminiContents = async (profile: any) => {
    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
    const promptText = promptRef.current.trim();
    if (promptText) {
      parts.push({ text: promptText });
    }
    for (const file of fileList) {
      if (!file.originFileObj) continue;
      const base64 = await getBase64(file.originFileObj);
      const converted = await maybeConvertToWebp(base64, profile);
      const resolvedMime = converted.mimeType || file.type || 'image/png';
      const payload = normalizeBase64Payload(converted.data);
      parts.push({ inline_data: { mime_type: resolvedMime, data: payload } });
    }
    return [{ role: 'user', parts }];
  };

  const buildGeminiGenerationConfig = (profile: any) => {
    const generationConfig: Record<string, unknown> = {};
    if (profile.includeImageConfig) {
      const imageSize = profile.imageConfig?.imageSize || '2K';
      const aspectRatio = profile.imageConfig?.aspectRatio || 'auto';
      const imageConfig: Record<string, string> = { imageSize };
      if (aspectRatio && aspectRatio !== 'auto') {
        imageConfig.aspectRatio = aspectRatio;
      }
      generationConfig.imageConfig = imageConfig;
      if (profile.useResponseModalities) {
        generationConfig.responseModalities = ['TEXT', 'IMAGE'];
      }
    }
    if (profile.includeThoughts) {
      const budget = clampNumber(
        Math.round(typeof profile.thinkingBudget === 'number' ? profile.thinkingBudget : 128),
        0,
        8192,
      );
      generationConfig.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true,
      };
    }
    return Object.keys(generationConfig).length > 0 ? generationConfig : null;
  };

  const buildGeminiSafetySettings = (profile: any) => {
    if (!profile.includeSafetySettings || !profile.safety) return null;
    const entries = Object.entries(profile.safety).filter(
      ([, threshold]) => threshold && threshold !== 'OFF',
    );
    if (entries.length === 0) return null;
    return entries.map(([category, threshold]) => ({
      category,
      threshold,
    }));
  };

  const mergeGeminiCustomJson = (payload: Record<string, unknown>, profile: any) => {
    const raw = typeof profile.customJson === 'string' ? profile.customJson.trim() : '';
    if (!raw) return payload;
    try {
      const custom = JSON.parse(raw);
      if (!custom || typeof custom !== 'object' || Array.isArray(custom)) {
        return payload;
      }
      const mergedGenerationConfig = {
        ...(payload.generationConfig as Record<string, unknown> | undefined),
        ...(custom.generationConfig || {}),
      };
      return {
        ...payload,
        ...custom,
        generationConfig:
          Object.keys(mergedGenerationConfig).length > 0 ? mergedGenerationConfig : undefined,
        safetySettings: custom.safetySettings ?? payload.safetySettings,
      };
    } catch (err) {
      console.warn('自定义 JSON 解析失败，已忽略。', err);
      return payload;
    }
  };

  const buildGeminiPayload = (contents: Array<Record<string, unknown>>, profile: any) => {
    const payload: Record<string, unknown> = { contents };
    const generationConfig = buildGeminiGenerationConfig(profile);
    if (generationConfig) {
      payload.generationConfig = generationConfig;
    }
    const safetySettings = buildGeminiSafetySettings(profile);
    if (safetySettings) {
      payload.safetySettings = safetySettings;
    }
    return mergeGeminiCustomJson(payload, profile);
  };

  const buildGeminiRequest = (profile: any) => {
    const apiFormat = profile.apiFormat || 'openai';
    const format = apiFormat === 'vertex' ? 'vertex' : 'gemini';
    const apiUrl = resolveApiUrl(profile.apiUrl, format);
    const baseInfo = normalizeApiBase(apiUrl);
    const baseOrigin = baseInfo.origin || apiUrl.replace(/\/+$/, '');
    const versionFallback = format === 'vertex' ? 'v1beta1' : 'v1beta';
    const version = resolveApiVersion(apiUrl, profile.apiVersion, versionFallback);
    const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
    const segments = [...baseInfo.segments];

    if (!hasVersion && version) {
      const markerIndex = segments.findIndex((segment) => apiMarkerSegments.has(segment));
      if (markerIndex >= 0) {
        segments.splice(markerIndex, 0, version);
      } else {
        segments.push(version);
      }
    }

    const modelValue = (profile.model || '').trim();
    if (!modelValue) {
      throw new Error('请填写模型名称');
    }

    const modelSegments = modelValue.split('/').filter(Boolean);
    const modelHasProjectPath = modelSegments.includes('projects');
    const geminiModelIsPath = modelSegments[0] === 'models';
    const normalizedModel = geminiModelIsPath ? modelSegments.slice(1).join('/') : modelValue;

    const applyModelPath = () => {
      const modelIndex = segments.indexOf('models');
      if (geminiModelIsPath) {
        if (modelIndex >= 0 && modelSegments[0] === 'models') {
          segments.splice(modelIndex + 1);
          segments.push(...modelSegments.slice(1));
        } else {
          segments.push(...modelSegments);
        }
        return;
      }
      if (modelIndex >= 0) {
        segments.splice(modelIndex + 1);
        segments.push(modelValue);
      } else {
        segments.push('models', modelValue);
      }
    };

    const ensureMarkerValue = (marker: string, value?: string) => {
      const idx = segments.indexOf(marker);
      if (idx === -1) {
        if (!value) return false;
        segments.push(marker, value);
        return true;
      }
      const next = segments[idx + 1];
      if (!next || apiMarkerSegments.has(next) || isVersionSegment(next)) {
        if (!value) return false;
        segments.splice(idx + 1, 0, value);
        return true;
      }
      return true;
    };

    if (format === 'vertex') {
      const projectId =
        profile.vertexProjectId?.trim() || extractVertexProjectId(apiUrl) || '';
      const location = profile.vertexLocation?.trim() || 'us-central1';
      const publisher = profile.vertexPublisher?.trim() || 'google';
      const hasProjectsMarker = segments.includes('projects');
      const useVertexMarkers = Boolean(projectId || hasProjectsMarker || modelHasProjectPath);

      if (modelHasProjectPath) {
        segments.push(...modelSegments);
      } else if (useVertexMarkers) {
        if (projectId) {
          ensureMarkerValue('projects', projectId);
        }
        if (segments.includes('projects') || projectId) {
          ensureMarkerValue('locations', location);
          ensureMarkerValue('publishers', publisher);
        }
        if (segments.includes('projects') || projectId) {
          ensureMarkerValue('models', normalizedModel);
        } else {
          applyModelPath();
        }
      } else {
        applyModelPath();
      }
    } else {
      applyModelPath();
    }

    const suffix = config.stream ? ':streamGenerateContent' : ':generateContent';
    let url = `${baseOrigin}${segments.length ? `/${segments.join('/')}` : ''}${suffix}`;
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const isOfficial =
      format === 'vertex'
        ? baseInfo.host === 'aiplatform.googleapis.com'
        : baseInfo.host === 'generativelanguage.googleapis.com';
    if (isOfficial) {
      url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(profile.apiKey)}`;
    } else {
      headers.Authorization = `Bearer ${profile.apiKey}`;
    }
    return { url, headers };
  };

  const readGeminiStream = async (response: Response) => {
    const reader = response.body?.getReader();
    if (!reader) {
      return response.json();
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let lastJson: any = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line) continue;
        const cleaned = line.replace(/^data:\s*/i, '').trim();
        if (!cleaned || cleaned === '[DONE]') continue;
        try {
          lastJson = JSON.parse(cleaned);
        } catch {
          // ignore partial lines
        }
      }
    }

    const tail = decoder.decode();
    if (tail) {
      buffer += tail;
    }
    const remainder = buffer.trim();
    if (remainder) {
      const cleaned = remainder.replace(/^data:\s*/i, '').trim();
      if (cleaned && cleaned !== '[DONE]') {
        try {
          lastJson = JSON.parse(cleaned);
        } catch {
          // ignore
        }
      }
    }

    return lastJson;
  };

  const registerObjectUrl = (key: string, url: string) => {
    const existing = objectUrlMapRef.current.get(key);
    if (existing && existing !== url) {
      URL.revokeObjectURL(existing);
    }
    objectUrlMapRef.current.set(key, url);
  };

  const clearObjectUrl = (key: string) => {
    const existing = objectUrlMapRef.current.get(key);
    if (existing) {
      URL.revokeObjectURL(existing);
      objectUrlMapRef.current.delete(key);
    }
  };

  const clearRetryTimer = (subTaskId: string) => {
    const timerId = retryTimersRef.current.get(subTaskId);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      retryTimersRef.current.delete(subTaskId);
    }
  };

  const abortSubTaskRequest = (subTaskId: string) => {
    const controller = abortControllersRef.current.get(subTaskId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(subTaskId);
    }
  };

  const persistImageLocally = async (sourceUrl: string, key: string) => {
    try {
      const isHttp = /^https?:\/\//i.test(sourceUrl);
      const isData = sourceUrl.startsWith('data:image');
      if (!isHttp && !isData) {
        return { displayUrl: sourceUrl, localKey: undefined };
      }

      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('图片下载失败');
      const blob = await response.blob();
      await saveImageBlob(key, blob);
      const objectUrl = URL.createObjectURL(blob);
      return { displayUrl: objectUrl, localKey: key };
    } catch (err) {
      console.warn('图片缓存失败，回退为直链显示:', err);
      return { displayUrl: sourceUrl, localKey: undefined };
    }
  };

  const getPreferredImageSrc = (result: SubTaskResult) => {
    const sourceUrl = result.sourceUrl;
    if (sourceUrl && (/^https?:\/\//i.test(sourceUrl) || sourceUrl.startsWith('data:image'))) {
      return sourceUrl;
    }
    return result.displayUrl || sourceUrl;
  };

  const updateResult = (id: string, updates: Partial<SubTaskResult>) => {
    setResults((prev: SubTaskResult[]) => {
      const updated = prev.map((r: SubTaskResult) => {
        if (r.id !== id) return r;
        const next = { ...r, ...updates };
        if (Object.prototype.hasOwnProperty.call(updates, 'displayUrl')) {
          if (next.displayUrl && next.displayUrl.startsWith('blob:')) {
            registerObjectUrl(id, next.displayUrl);
          } else {
            clearObjectUrl(id);
          }
        }
        return next;
      });
      currentResultsRef.current = updated;
      return updated;
    });
  };

  const updateStats = (type: 'request' | 'success' | 'fail', duration?: number) => {
    setStats((prev: TaskStats) => {
      const newState = {
        ...prev,
        totalRequests: type === 'request' ? prev.totalRequests + 1 : prev.totalRequests,
        successCount: type === 'success' ? prev.successCount + 1 : prev.successCount,
      };
      if (type === 'success' && duration) {
        newState.totalTime = prev.totalTime + duration;
        newState.fastestTime = prev.fastestTime === 0 ? duration : Math.min(prev.fastestTime, duration);
        newState.slowestTime = Math.max(prev.slowestTime, duration);
      }
      return newState;
    });
    onStatsUpdate(type, duration);
  };

  const resetTaskForGenerate = (task: SubTaskResult, startTime: number): SubTaskResult => ({
    ...task,
    status: 'loading',
    error: undefined,
    autoRetry: true,
    displayUrl: undefined,
    localKey: undefined,
    sourceUrl: undefined,
    savedLocal: false,
    startTime,
    endTime: undefined,
    duration: undefined,
    retryCount: 0
  });

  const getActiveProfile = () => {
    return config.apiProfiles?.find(p => p.id === apiProfileId) || config;
  };

  const handleGenerate = async () => {
    const profile = getActiveProfile();
    if (!profile.apiKey) {
      message.error('请先配置 API Key');
      return;
    }
    const hasImage = fileList.length > 0;
    if (!prompt && !hasImage) {
      message.warning('请输入提示词或上传参考图');
      return;
    }
    generationEpochRef.current += 1;

    results.forEach((task) => {
      clearRetryTimer(task.id);
      clearObjectUrl(task.id);
      isRetryingRef.current.delete(task.id);
      taskStartTimesRef.current.delete(task.id);
    });

    setIsGlobalLoading(true);
    taskDoneRef.current = false;
    runSuccessCountRef.current = 0;
    setGeneratedImages([]);
    setGenPreviewIndex(0);
    setPreviewVisible(false);

    const startTime = Date.now();
    setElapsedNow(startTime);
    const tasksToReuse = results.slice(0, concurrency);
    const numNewTasks = Math.max(0, concurrency - tasksToReuse.length);
    
    const newSubTasks: SubTaskResult[] = Array.from({ length: numNewTasks }).map(() => ({
      id: uuidv4(),
      status: 'loading',
      autoRetry: true,
      retryCount: 0,
      startTime,
      savedLocal: false
    }));

    const resetTasks = tasksToReuse.map(task => resetTaskForGenerate(task, startTime));
    const nextResults =
      newSubTasks.length > 0 ? [...newSubTasks, ...resetTasks] : resetTasks;
    currentResultsRef.current = nextResults;
    setResults(nextResults);

    // 启动所有任务（新的 + 复用的）
    [...newSubTasks, ...resetTasks].forEach(task => {
      taskStartTimesRef.current.set(task.id, startTime);
      isRetryingRef.current.set(task.id, true);
      performRequest(task.id);
    });
  };

  const handleRetrySingle = (subTaskId: string) => {
    const nextStartTime = Date.now();
    clearRetryTimer(subTaskId);
    setElapsedNow(nextStartTime);
    updateResult(subTaskId, { status: 'loading', error: undefined, autoRetry: true, displayUrl: undefined, localKey: undefined, sourceUrl: undefined, savedLocal: false, startTime: nextStartTime, endTime: undefined, duration: undefined });
    taskStartTimesRef.current.set(subTaskId, nextStartTime);
    isRetryingRef.current.set(subTaskId, true);
    performRequest(subTaskId);
  };

  const handleStopSingle = (subTaskId: string) => {
    isRetryingRef.current.set(subTaskId, false);
    abortSubTaskRequest(subTaskId);
    clearRetryTimer(subTaskId);
    updateResult(subTaskId, { status: 'error', error: '已停止', autoRetry: false });
  };

  const performRequest = async (subTaskId: string) => {
    if (abortControllersRef.current.has(subTaskId)) {
      return;
    }
    const controller = new AbortController();
    abortControllersRef.current.set(subTaskId, controller);
    updateStats('request');
    const startTime = taskStartTimesRef.current.get(subTaskId) || Date.now();
    const requestEpoch = generationEpochRef.current;
    const requestSnapshot = buildCollectionRequestSnapshot(prompt);
    requestContextByResultIdRef.current.set(subTaskId, requestSnapshot);

    try {
      const profile = getActiveProfile();
      const apiFormat = profile.apiFormat || 'openai';
      const hasImage = fileList.length > 0;
      let imageUrl: string | null = null;
      let rawResponse: string | undefined;

      if (apiFormat === 'openai-image') {
        const apiUrl = resolveApiUrl(profile.apiUrl, 'openai-image');
        const baseInfo = normalizeApiBase(apiUrl);
        const basePath = baseInfo.origin
          ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
          : apiUrl.replace(/\/+$/, '');
        const version = resolveApiVersion(apiUrl, profile.apiVersion, 'v1');
        const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
        const openAiBase = hasVersion ? basePath : `${basePath}/${version}`;
        const endpoint = hasImage ? 'images/edits' : 'images/generations';
        const requestUrl = openAiBase.endsWith(`/${endpoint}`)
          ? openAiBase
          : `${openAiBase}/${endpoint}`;

        const headers: Record<string, string> = {
          'Authorization': `Bearer ${profile.apiKey}`,
        };

        let responseData: any;

        if (hasImage) {
          const formData = new FormData();
          const file = fileList[0];
          if (file.originFileObj) {
            formData.append('image', file.originFileObj);
          }
          formData.append('prompt', promptRef.current);
          formData.append('model', profile.model);
          formData.append('n', '1');
          formData.append('moderation', 'low');

          if (config.stream) {
            formData.append('stream', 'true');
            const fetchResponse = await fetch(requestUrl, {
              method: 'POST',
              headers: { Authorization: `Bearer ${profile.apiKey}` },
              body: formData,
              signal: controller.signal,
            });
            if (!fetchResponse.ok) {
              throw new Error(
                await formatResponseErrorMessage(
                  fetchResponse,
                  fetchResponse.statusText || '请求失败',
                ),
              );
            }
            responseData = await readGeminiStream(fetchResponse);
          } else {
            const response = await axios.post(requestUrl, formData, {
              headers,
              signal: controller.signal,
            });
            responseData = response.data;
          }
        } else {
          const payload = { model: profile.model, prompt: promptRef.current, n: 1, moderation: 'low' };

          if (config.stream) {
            const fetchResponse = await fetch(requestUrl, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...payload, stream: true }),
              signal: controller.signal,
            });
            if (!fetchResponse.ok) {
              throw new Error(
                await formatResponseErrorMessage(
                  fetchResponse,
                  fetchResponse.statusText || '请求失败',
                ),
              );
            }
            responseData = await readGeminiStream(fetchResponse);
          } else {
            const response = await axios.post(requestUrl, payload, {
              headers: { ...headers, 'Content-Type': 'application/json' },
              signal: controller.signal,
            });
            responseData = response.data;
          }
        }

        rawResponse = JSON.stringify(responseData);
        imageUrl = resolveImageFromResponse(responseData);
      } else if (apiFormat === 'openai') {
        const apiUrl = resolveApiUrl(profile.apiUrl, 'openai');
        const baseInfo = normalizeApiBase(apiUrl);
        const basePath = baseInfo.origin
          ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
          : apiUrl.replace(/\/+$/, '');
        const version = resolveApiVersion(apiUrl, profile.apiVersion, 'v1');
        const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
        const openAiBase = hasVersion ? basePath : `${basePath}/${version}`;
        const chatUrl = openAiBase.endsWith('/chat/completions')
          ? openAiBase
          : `${openAiBase}/chat/completions`;

        const messages: any[] = [];
        const content: any[] = [];
        if (prompt) {
          content.push({ type: 'text', text: prompt });
        }
        if (hasImage) {
          for (const file of fileList) {
            if (file.originFileObj) {
              const base64 = await getBase64(file.originFileObj);
              content.push({
                type: 'image_url',
                image_url: {
                  url: base64,
                },
              });
            }
          }
        }
        messages.push({
          role: 'user',
          content,
        });
        const headers = {
          'Authorization': `Bearer ${profile.apiKey}`,
          'x-api-key': profile.apiKey,
        };

        if (config.stream) {
          const fetchResponse = await fetch(chatUrl, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: profile.model, messages, stream: true }),
            signal: controller.signal,
          });

          if (!fetchResponse.ok) {
            throw new Error(
              await formatResponseErrorMessage(
                fetchResponse,
                fetchResponse.statusText || '请求失败',
              ),
            );
          }

          const reader = fetchResponse.body?.getReader();
          const decoder = new TextDecoder();
          let generatedText = '';
          let pending = '';
          const consumeLine = (line: string) => {
            const cleaned = line.replace(/\r$/, '');
            if (!cleaned.startsWith('data:')) return;
            const payload = cleaned.slice(5).trimStart();
            if (!payload || payload === '[DONE]') return;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) generatedText += delta.content;
              if (delta?.reasoning_content) generatedText += delta.reasoning_content;
            } catch (e) { /* ignore */ }
          };

          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              pending += decoder.decode(value, { stream: true });
              let newlineIndex = pending.indexOf('\n');
              while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex);
                pending = pending.slice(newlineIndex + 1);
                consumeLine(line);
                newlineIndex = pending.indexOf('\n');
              }
            }
            const tail = decoder.decode();
            if (tail) pending += tail;
          }
          if (pending) {
            consumeLine(pending);
          }
          rawResponse = generatedText;
          imageUrl = parseMarkdownImage(generatedText);
        } else {
          const response = await axios.post(
            chatUrl,
            { model: profile.model, messages, stream: false },
            { headers: { ...headers, 'Content-Type': 'application/json' }, signal: controller.signal }
          );
          rawResponse = JSON.stringify(response.data);
          imageUrl = resolveImageFromResponse(response.data);
        }
      } else {
        const contents = await buildGeminiContents(profile);
        const { url, headers } = buildGeminiRequest(profile);
        const payload = buildGeminiPayload(contents, profile);
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            await formatResponseErrorMessage(response, response.statusText || '请求失败'),
          );
        }
        const data = config.stream ? await readGeminiStream(response) : await response.json();
        rawResponse = JSON.stringify(data);
        imageUrl = resolveImageFromResponse(data);
      }

      if (imageUrl && /^http:\/\//i.test(imageUrl)) {
        const warnMsg = `任务 ${subTaskId.slice(0, 8)}: 图片 URL 使用非加密 HTTP 协议 — ${imageUrl}`;
        message.warning(warnMsg);
        onLog?.({ id: uuidv4(), taskId: id, message: warnMsg, timestamp: Date.now() });
      }
      
      if (imageUrl) {
        if (generationEpochRef.current !== requestEpoch) return;

        const currentTask = currentResultsRef.current.find(r => r.id === subTaskId);
        if (currentTask?.status === 'error') {
          const paperEl = document.getElementById(`paper-${subTaskId}`);
          if (paperEl) {
            paperEl.classList.add('polaroid-dropping');
            await new Promise(resolve => setTimeout(resolve, 400));
          }
        }

        const endTime = Date.now();
        const duration = endTime - startTime;
        const { displayUrl, localKey } = await persistImageLocally(imageUrl, `${subTaskId}:${endTime}`);
        updateResult(subTaskId, { status: 'success', error: undefined, autoRetry: false, displayUrl, localKey, sourceUrl: imageUrl, savedLocal: false, endTime, duration });
        updateStats('success', duration);
        
        if (config.enableCollection && onCollect) {
          const collectionKey = buildResultCollectionKey(subTaskId, endTime);
          await collectImageForCollection({
            collectionKey,
            sourceUrl: imageUrl,
            sourceLocalKey: localKey,
            prompt: requestSnapshot.prompt,
            timestamp: endTime,
            taskId: id,
          });
          collectReferenceImagesForCollection(requestSnapshot);
        }

        const generatedImageId = uuidv4();
        let generatedImageUrl = displayUrl;
        if (localKey) {
          const blob = await getImageBlob(localKey);
          if (blob) {
            generatedImageUrl = URL.createObjectURL(blob);
            registerObjectUrl(generatedImageId, generatedImageUrl);
          }
        }
        setGeneratedImages(prev => [{
          id: generatedImageId,
          displayUrl: generatedImageUrl,
          localKey,
          sourceUrl: imageUrl,
          timestamp: endTime,
        }, ...prev]);

        runSuccessCountRef.current += 1;
        const currentGenCount = generationCountRef.current;

        if (runSuccessCountRef.current >= currentGenCount) {
          isRetryingRef.current.set(subTaskId, false);
          taskDoneRef.current = true;
          currentResultsRef.current.forEach(r => {
            if (r.id !== subTaskId && (r.status === 'loading' || r.autoRetry)) {
              clearRetryTimer(r.id);
              isRetryingRef.current.set(r.id, false);
            }
          });
        } else {
          clearRetryTimer(subTaskId);
          const timerId = window.setTimeout(() => {
            clearRetryTimer(subTaskId);
            if (taskDoneRef.current) {
              updateResult(subTaskId, { status: 'error', error: '已停止', autoRetry: false });
              return;
            }
            if (isRetryingRef.current.get(subTaskId)) {
              const nextStartTime = Date.now();
              setElapsedNow(nextStartTime);
              updateResult(subTaskId, {
                status: 'loading',
                displayUrl: undefined,
                localKey: undefined,
                sourceUrl: undefined,
                savedLocal: false,
                autoRetry: true,
                error: undefined,
                startTime: nextStartTime,
                retryCount: 0,
                endTime: undefined,
                duration: undefined,
              });
              taskStartTimesRef.current.set(subTaskId, nextStartTime);
              performRequest(subTaskId);
            }
          }, 0);
          retryTimersRef.current.set(subTaskId, timerId);
        }
      } else {
        throw new Error('未在响应中找到图片数据。响应原文：\n' + (rawResponse || ''));
      }

    } catch (err: any) {
      if (axios.isCancel(err) || err.name === 'AbortError') {
        return;
      }
      if (generationEpochRef.current !== requestEpoch) return;

      console.error('Generation error:', err);
      const errorMessage = formatUnknownErrorMessage(err, '未知错误');
      onLog?.({ id: uuidv4(), taskId: id, message: errorMessage, timestamp: Date.now() });
      updateStats('fail');
      
      const shouldRetry = isRetryingRef.current.get(subTaskId);
      const { interval, limit } = retrySettingsRef.current;
      const currentTask = currentResultsRef.current.find(r => r.id === subTaskId);
      const currentRetryCount = currentTask?.retryCount || 0;
      const canRetry = limit === -1 || currentRetryCount < limit;
      
      if (currentTask?.status === 'error') {
        const paperEl = document.getElementById(`paper-${subTaskId}`);
        if (paperEl) {
          paperEl.classList.add('polaroid-dropping');
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      }

      if (shouldRetry && canRetry) {
        setResults(prev => {
          const updated = prev.map<SubTaskResult>((r) => {
            if (r.id !== subTaskId) return r;
            return {
              ...r,
              status: 'error',
              error: `${errorMessage} (${interval / 1000}s后重试...)`,
              autoRetry: true,
              retryCount: currentRetryCount + 1
            };
          });
          currentResultsRef.current = updated;
          return updated;
        });

        clearRetryTimer(subTaskId);
        const timerId = window.setTimeout(() => {
          clearRetryTimer(subTaskId);
          if (isRetryingRef.current.get(subTaskId)) { 
            const nextStartTime = Date.now();
            setElapsedNow(nextStartTime);
            updateResult(subTaskId, {
              status: 'loading',
              error: undefined,
              autoRetry: true,
              startTime: nextStartTime,
              endTime: undefined,
              duration: undefined,
            });
            taskStartTimesRef.current.set(subTaskId, nextStartTime);
            performRequest(subTaskId);
          } else {
            updateResult(subTaskId, { status: 'error', error: '已暂停重试', autoRetry: false });
          }
        }, interval);
        retryTimersRef.current.set(subTaskId, timerId);
      } else {
        isRetryingRef.current.set(subTaskId, false);
        updateResult(subTaskId, { status: 'error', error: errorMessage, autoRetry: false, retryCount: currentRetryCount + 1 });
      }
    } finally {
      abortControllersRef.current.delete(subTaskId);
      if (abortControllersRef.current.size === 0 && Array.from(isRetryingRef.current.values()).every(v => !v)) {
        setIsGlobalLoading(false);
      }
    }
  };

  const handleStopAll = () => {
    results.forEach((result) => {
      isRetryingRef.current.set(result.id, false);
      clearRetryTimer(result.id);
    });
    setResults((prev) =>
      {
        const updated = prev.map<SubTaskResult>((item) => {
          if (item.status !== 'error' || !item.autoRetry) return item;
          const stripped = (item.error || '').replace(/\s*\([^(]*后重试\.\.\.\)\s*$/, '').trim();
          return { ...item, autoRetry: false, error: stripped || '已停止', endTime: item.endTime || Date.now() };
        });
        currentResultsRef.current = updated;
        return updated;
      },
    );
    message.info('已停止所有请求');
    setIsGlobalLoading(false);
  };

  const scrollGalleryTo = (idx: number) => {
    const container = galleryRef.current;
    if (!container) return;
    const child = container.children[idx] as HTMLElement;
    if (child) {
      child.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  };

  const navigateGenImage = (direction: -1 | 1) => {
    const genCount = generatedImages.length;
    if (genCount <= 1) return;
    const newIdx = (genPreviewIndexRef.current + direction + genCount) % genCount;
    setGenPreviewIndex(newIdx);
    scrollGalleryTo(newIdx);
  };

  // Keyboard navigation for generated gallery
  useEffect(() => {
    const el = galleryRef.current;
    if (!el || generatedImages.length <= 1) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateGenImage(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateGenImage(1);
      }
    };
    el.addEventListener('keydown', handleKeyDown);
    el.setAttribute('tabindex', '0');
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [generatedImages.length, navigateGenImage]);

  const handleGenGalleryTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleGenGalleryTouchEnd = (e: React.TouchEvent) => {
    const genCount = generatedImages.length;
    if (genCount <= 1) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(dx) < 40) return;
    if (Math.abs(dy) > Math.abs(dx) * 0.6) return;
    if (dx > 0) {
      navigateGenImage(-1);
    } else {
      navigateGenImage(1);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length === 0) return;

    const newUploads: UploadFile[] = files.map((file) => ({
      uid: uuidv4(),
      name: file.name,
      status: 'done',
      originFileObj: file as RcFile,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
    }));

    handleUploadChange({ fileList: [...fileList, ...newUploads] });
  };

  const handleUploadChange = ({ fileList: newFileList }: { fileList: UploadFile[] }) => {
    const fromCollectionMap = new Map(
      fileList.map((file) => [file.uid, file.fromCollection]),
    );
    const signatureMap = new Map(
      fileList.map((file) => [file.uid, file.sourceSignature]),
    );
    const normalized = newFileList.map((file) => {
      const next = { ...file, originFileObj: file.originFileObj } as UploadFileWithMeta;
      if (fromCollectionMap.get(next.uid)) {
        next.fromCollection = true;
      }
      const existingSignature = signatureMap.get(next.uid);
      if (existingSignature) {
        next.sourceSignature = existingSignature;
      }
      if (file.originFileObj && !next.originFileObj) {
        next.originFileObj = file.originFileObj;
      }
      if (!next.localKey) {
        next.localKey = buildUploadKey(next.uid);
      }
      if (!next.thumbUrl && next.originFileObj) {
        const objectUrl = URL.createObjectURL(next.originFileObj);
        const previewKey = next.localKey || buildUploadKey(next.uid);
        registerObjectUrl(previewKey, objectUrl);
        next.thumbUrl = objectUrl;
      }
      if (next.originFileObj) {
        next.type = next.type || next.originFileObj.type;
        next.size = next.size ?? next.originFileObj.size;
        next.lastModified = next.lastModified ?? next.originFileObj.lastModified;
      }
      if (!next.sourceSignature) {
        const signature = buildUploadSignature(next);
        if (signature) {
          next.sourceSignature = signature;
        }
      }
      if (!next.status) {
        next.status = 'done';
      }
      return next;
    });
    setFileList(normalized);
  };

  const successRate = calculateSuccessRate(
    stats.totalRequests,
    stats.successCount,
  );

  const averageTime = stats.successCount > 0 
    ? formatDuration(stats.totalTime / stats.successCount)
    : '0s';
  
  const fastestTimeStr = formatDuration(stats.fastestTime);
  const slowestTimeStr = formatDuration(stats.slowestTime);

  return (
    <div
      className="moe-card"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderColor: isDragOver ? '#FF9EB5' : undefined,
        borderStyle: isDragOver ? 'dashed' : undefined,
        borderWidth: isDragOver ? 2 : undefined,
        transition: 'all 0.2s',
        position: 'relative',
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(4px)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'inherit',
          pointerEvents: 'none',
          animation: 'fadeIn 0.2s ease-out',
        }}>
          <div style={{
            background: '#FFF0F3',
            width: 80,
            height: 80,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
            boxShadow: '0 4px 12px rgba(255, 158, 181, 0.2)'
          }}>
            <CloudUploadOutlined style={{ fontSize: 40, color: '#FF9EB5' }} />
          </div>
          <Text strong style={{ fontSize: 16, color: '#665555' }}>释放以添加参考图</Text>
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4 }}>支持 JPG, PNG, WebP, GIF</Text>
        </div>
      )}
      
      {/* Header */}
      <div style={{ 
        padding: '12px 16px', 
        borderBottom: '2px dashed #FFF0F3',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: '#fff',
        position: 'relative',
        overflow: 'hidden'
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ position: 'absolute', top: -2, right: 30, opacity: 0.8, transform: 'rotate(15deg)' }}>
          <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" fill="#FFE5A0"/>
        </svg>
        <Space>
          <div 
            style={{ 
              cursor: 'grab', 
              marginRight: 4, 
              display: 'flex', 
              alignItems: 'center',
              color: '#D0C0C0',
              touchAction: 'none'
            }}
            {...dragAttributes}
            {...dragListeners}
          >
            <HolderOutlined style={{ fontSize: 16 }} />
          </div>
          <div style={{ 
            width: 28, height: 28, 
            background: '#FFF0F3', 
            borderRadius: 8, 
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#FF9EB5'
          }}>
            <PictureFilled style={{ fontSize: 14 }} />
          </div>
          <Text strong style={{ fontSize: 14, color: '#665555' }}>任务 #{id.slice(0, 6).toUpperCase()}</Text>
          <div 
            className={isGlobalLoading ? 'api-select-running' : ''}
            style={{
              background: isGlobalLoading ? '#F6FFED' : '#FFF8FA',
              borderRadius: 12,
              padding: '0',
              border: `1px solid ${isGlobalLoading ? '#B7EB8F' : '#FFE5EA'}`,
              display: 'flex',
              alignItems: 'center',
              marginLeft: 4,
              height: 24,
              transition: 'all 0.3s ease',
            }}
          >
            <div 
              className={isGlobalLoading ? 'api-select-dot-running' : ''}
              style={{ 
                width: 6, 
                height: 6, 
                borderRadius: '50%', 
                background: isGlobalLoading ? '#52C41A' : '#FF9EB5', 
                margin: '0 0 0 8px',
                transition: 'all 0.3s ease'
              }} 
            />
            <Select
              size="small"
              value={apiProfileId}
              onChange={handleApiProfileChange}
              options={(config.apiProfiles || [{ id: 'default', name: '默认配置' }]).map(p => ({ label: p.name, value: p.id }))}
              style={{ minWidth: 80 }}
              variant="borderless"
              popupMatchSelectWidth={false}
              dropdownStyle={{ minWidth: 120, borderRadius: 8 }}
            />
          </div>
        </Space>
        <Button 
          type="text" 
          danger 
          icon={<DeleteFilled />} 
          onClick={onRemove} 
          size="small"
          style={{ color: '#FFB7C5' }} 
        />
      </div>

      {/* Stats Bar - 紧凑设计 */}
      <div style={{ 
        padding: '12px 16px', 
        background: '#FAFAFA',
        borderBottom: '2px dashed #FFF0F3',
        fontSize: 12
      }}>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(6, 1fr)', 
          gap: 4,
          textAlign: 'center'
        }}>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>请求</div>
            <div style={{ fontWeight: 700, color: '#665555' }}>{stats.totalRequests}</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>成功</div>
            <div style={{ fontWeight: 700, color: '#4CAF50' }}>{stats.successCount}</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>成功率</div>
            <div style={{ fontWeight: 700, color: successRate > 80 ? '#4CAF50' : '#FFC107' }}>{successRate}%</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>最快</div>
            <div style={{ fontWeight: 700, color: '#2196F3' }}>{fastestTimeStr}</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>最慢</div>
            <div style={{ fontWeight: 700, color: '#FF5252' }}>{slowestTimeStr}</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>平均</div>
            <div style={{ fontWeight: 700, color: '#9C27B0' }}>{averageTime}</div>
          </div>
        </div>
      </div>

      {/* Input Area */}
      <div style={{ padding: '16px', background: 'linear-gradient(180deg, #FAFAFA 0%, #fff 100%)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 独立便签输入框 */}
          <div className="sticky-note-container">
            <div className="sticky-note-fold-effect top" />
            <div
              ref={stickyNoteWrapRef}
              className={`sticky-note-inner-wrap ${isGlobalLoading ? 'rolling' : ''}`}
              onAnimationEnd={(e) => {
                if (e.animationName === 'conveyor-roll-wrap-down') {
                  e.currentTarget.classList.remove('rolling');
                }
              }}
            >
              <div className="sticky-note-bg-layer" />
              <TextArea 
                ref={promptTextareaRef}
                className="sticky-note-textarea"
                placeholder="在此描述您的想象..." 
                value={prompt} 
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => handlePromptChange(e.target.value)}
                onFocus={handlePromptFocus}
                onBlur={handlePromptBlur}
                onScroll={syncStickyNoteScroll}
                onPaste={handlePromptPaste}
                autoSize={{ minRows: 2, maxRows: 15 }}
                variant="borderless"
              />
            </div>
            <div className="sticky-note-fold-effect bottom" />
          </div>
          
          {/* 图片预览区域 */}
          {fileList.length > 0 && (
            <div style={{ padding: '0 4px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {fileList.map((file, index) => (
                <div key={file.uid} style={{ position: 'relative', width: 60, height: 60 }}>
                  <PrivacyBlur enabled={config.privacyMode ?? false}>
                    <Image
                      src={file.thumbUrl || ''} 
                      alt="preview" 
                      style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 8 }}
                      width={60}
                      height={60}
                    />
                  </PrivacyBlur>
                  <div 
                    style={{ 
                      position: 'absolute', top: -6, right: -6, 
                      background: '#fff', borderRadius: '50%', cursor: 'pointer',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                      zIndex: 1
                    }}
                    onClick={() => {
                      const newFileList = [...fileList];
                      newFileList.splice(index, 1);
                      setFileList(newFileList);
                    }}
                  >
                    <CloseCircleFilled style={{ color: '#FF5252', fontSize: 16 }} />
                  </div>
                </div>
              ))}
            </div>
          )}

        {/* 工具栏 */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          padding: '0 4px',
          marginTop: '4px'
        }}>
            <Space size={8}>
              <Upload
                fileList={fileList}
                onChange={handleUploadChange}
                beforeUpload={() => false}
                multiple
                showUploadList={false}
              >
                <Tooltip title="上传参考图">
                  <Button 
                    size="small" 
                    icon={<UploadOutlined />} 
                    style={fileList.length > 0 ? { 
                      background: '#FF9EB5', color: '#fff', border: 'none' 
                    } : { 
                      background: '#fff', color: '#998888', border: '1px solid #E8E8E8' 
                    }}
                  />
                </Tooltip>
              </Upload>

              <Space size={4} style={{ background: '#fff', padding: '2px 8px', borderRadius: 16, display: 'flex', alignItems: 'center', border: '1px solid #E8E8E8', height: '24px' }}>
                <Text style={{ fontSize: 10, whiteSpace: 'nowrap', color: '#998888' }}>并发</Text>
                <div style={{ width: 1, height: 10, background: '#E8E8E8', margin: '0 2px' }} />
                <input 
                  type="number"
                  min={1} 
                  value={concurrencyInput} 
                  onChange={(e) => handleConcurrencyInputChange(e.target.value)} 
                  onBlur={handleConcurrencyInputBlur}
                  style={{ 
                    width: 24, 
                    border: 'none', 
                    textAlign: 'center', 
                    color: '#998888', 
                    fontWeight: 700,
                    background: 'transparent',
                    outline: 'none',
                    fontSize: 12,
                    padding: 0,
                    height: 20
                  }}
                />
              </Space>

              <Tooltip title="声音提醒">
                <Button 
                  size="small" 
                  icon={enableSound ? <BellFilled /> : <BellOutlined />} 
                  style={{ 
                    color: enableSound ? '#FF9EB5' : '#998888',
                    background: '#fff',
                    border: enableSound ? '1px solid #FF9EB5' : '1px solid #E8E8E8'
                  }}
                  onClick={() => setEnableSound(!enableSound)}
                />
              </Tooltip>

              <Popover 
                content={
                  <Space direction="vertical" size={12} style={{ width: 160 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>重试间隔 (秒)</Text>
                      <InputNumber 
                        size="small" 
                        min={0} 
                        step={0.1}
                        bordered={false}
                        value={retryInterval / 1000} 
                        onChange={handleRetryIntervalChange} 
                        style={{ width: 60 }} 
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>重试次数</Text>
                      <InputNumber 
                        size="small" 
                        min={-1}
                        step={1}
                        bordered={false}
                        value={retryLimit} 
                        onChange={handleRetryLimitChange} 
                        style={{ width: 60 }} 
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>生成数量</Text>
                      <InputNumber 
                        size="small" 
                        min={1}
                        step={1}
                        bordered={false}
                        value={generationCount} 
                        onChange={handleGenerationCountChange} 
                        style={{ width: 60 }} 
                      />
                    </div>
                    <Text type="secondary" style={{ fontSize: 10, lineHeight: 1.2 }}>
                      * -1表示无限重试，0表示不重试
                    </Text>
                  </Space>
                }
                title={<Text strong style={{ fontSize: 13, color: '#665555' }}>任务设置</Text>}
                trigger="click"
                placement="bottom"
              >
                <Tooltip title="任务设置">
                  <Button 
                    size="small" 
                    icon={<SettingFilled />} 
                    style={{ 
                      color: '#998888',
                      background: '#fff',
                      border: '1px solid #E8E8E8'
                    }}
                  />
                </Tooltip>
              </Popover>
            </Space>

            {isGlobalLoading ? (
              <Button 
                danger 
                type="primary"
                icon={<PauseCircleFilled />} 
                onClick={handleStopAll} 
                size="small"
                style={{ borderRadius: 16, padding: '0 16px', height: 32, fontWeight: 700 }}
              >
                停止
              </Button>
            ) : (
              <Button 
                type="primary" 
                icon={<FireFilled />} 
                onClick={handleGenerate} 
                size="small"
                style={{ borderRadius: 16, padding: '0 20px', height: 32, fontWeight: 700 }}
              >
                生成
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Results Grid */}
      <div style={{ 
        flex: 1, 
        overflowY: 'auto', 
        padding: '0 16px 16px',
        minHeight: 200
      }}>
        {results.length === 0 && generatedImages.length === 0 ? (
          <div style={{ 
            height: '100%', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 12,
            color: '#D0C0C0',
            padding: '40px 0'
          }}>
            <StarFilled style={{ fontSize: 32, color: '#FFE5A0' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>准备好开始创作了吗？</Text>
          </div>
        ) : (
          <>
            {results.length > 0 && (
              <div className="mobile-compact-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {results.map((result: SubTaskResult) => {
                  const imageSrc = getPreferredImageSrc(result);
                  const currentElapsed = result.startTime ? Math.max(0, elapsedNow - result.startTime) : 0;
                  return (
                    <div key={result.id} className="polaroid-printer">
                      <div className="polaroid-slot-outer">
                        <div className="polaroid-slot-inner"></div>
                      </div>
                      <div className="polaroid-paper-container">
                        {result.status === 'loading' ? (
                          <div style={{ textAlign: 'center', padding: '40px 8px', marginTop: 20, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                            <Space direction="vertical" size={8}>
                              <Spin indicator={<LoadingOutlined style={{ fontSize: 24, color: '#FF9EB5' }} spin />} />
                              <Text type="secondary" style={{ fontSize: 10, fontWeight: 600 }}>
                                {result.retryCount > 0 ? `重试 (${result.retryCount})...` : '生成中...'}
                              </Text>
                              {currentElapsed > 0 && (
                                <Text type="secondary" style={{ fontSize: 10 }}>
                                  已用 {formatDuration(currentElapsed)}
                                </Text>
                              )}
                            </Space>
                            <div style={{ marginTop: 12 }}>
                              <Button
                                type="text"
                                size="small"
                                danger
                                icon={<PauseCircleFilled />}
                                onClick={() => handleStopSingle(result.id)}
                                style={{ background: 'rgba(255,255,255,0.8)', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(255,82,82,0.2)' }}
                              />
                            </div>
                          </div>
                        ) : (
                          <div id={`paper-${result.id}`} key={`paper-${result.id}-${result.retryCount || 0}`} className={`polaroid-paper ${result.status === 'error' ? 'error-state' : ''}`}>
                            <div style={{
                              position: 'relative',
                              paddingTop: '114.28%',
                              background: result.status === 'error' ? '#FFD1DC' : '#000',
                              width: '100%',
                              overflow: 'hidden',
                              boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.1)'
                            }}>
                              <div style={{
                                position: 'absolute',
                                top: 0, left: 0, right: 0, bottom: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}>
                                {result.status === 'success' && imageSrc ? (
                                  <>
                                  <PrivacyBlur enabled={config.privacyMode ?? false}>
                                    <Image
                                      src={imageSrc}
                                      alt="Generated"
                                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                      wrapperStyle={{ width: '100%', height: '100%' }}
                                    />
                                  </PrivacyBlur>
                                    {result.duration && (
                                      <div style={{
                                        position: 'absolute',
                                        bottom: 4,
                                        right: 4,
                                        color: 'rgba(255,255,255,0.9)',
                                        fontSize: '11px',
                                        fontFamily: 'monospace',
                                        textShadow: '1px 1px 0 rgba(0,0,0,0.8), -1px -1px 0 rgba(0,0,0,0.8), 1px -1px 0 rgba(0,0,0,0.8), -1px 1px 0 rgba(0,0,0,0.8), 0px 2px 4px rgba(0,0,0,0.5)',
                                        zIndex: 1,
                                        pointerEvents: 'none',
                                        letterSpacing: '0.5px',
                                        fontWeight: 600
                                      }}>
                                        {formatDuration(result.duration)}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <div style={{ textAlign: 'center', padding: 16 }}>
                                    <CloseCircleFilled style={{ fontSize: 32, color: '#FF5252', marginBottom: 8 }} />
                                    <div style={{ color: '#FF5252', fontSize: 12, fontWeight: 600, wordBreak: 'break-word', maxHeight: 80, overflow: 'auto' }}>
                                      {result.error || '生成失败'}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div style={{
                              marginTop: 8,
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              height: 24,
                              padding: '0 2px'
                            }}>
                              <Text style={{
                                fontSize: 12,
                                fontFamily: "'ZCOOL KuaiLe', cursive",
                                color: '#998888',
                                letterSpacing: '1px',
                                lineHeight: 1
                              }}>
                                moe atelier
                              </Text>
                              <div style={{ display: 'flex', gap: 8, zIndex: 11, alignItems: 'center' }}>
                                {result.status === 'error' && result.autoRetry && (
                                  <div style={{
                                    color: '#FF5252', fontSize: 14, cursor: 'pointer', transition: 'all 0.2s',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                                  }}
                                  className="hover-scale"
                                  onClick={() => handleStopSingle(result.id)}
                                  >
                                    <PauseCircleFilled />
                                  </div>
                                )}
                                <div style={{
                                  color: '#998888', fontSize: 14, cursor: 'pointer', transition: 'all 0.2s',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                                }}
                                className="hover-scale"
                                onClick={(e) => {
                                  const paperEl = e.currentTarget.closest('.polaroid-paper');
                                  if (paperEl) {
                                    paperEl.classList.add('polaroid-dropping');
                                    setTimeout(() => handleRetrySingle(result.id), 300);
                                  } else {
                                    handleRetrySingle(result.id);
                                  }
                                }}
                                >
                                  {result.status === 'error' && result.error === '已暂停重试' ?
                                    <PlayCircleFilled /> : <ReloadOutlined />
                                  }
                                </div>
                                {result.status === 'success' && imageSrc && (
                                  <div style={{
                                    color: '#998888', fontSize: 14, cursor: 'pointer', transition: 'all 0.2s',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                                  }}
                                  className="hover-scale"
                                  >
                                    <a href={imageSrc} download={`image-${result.localKey || result.id}.png`}
                                      style={{ color: 'inherit', display: 'flex' }}>
                                      <DownloadOutlined />
                                    </a>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {generatedImages.length > 0 && (
              <>
                {isGlobalLoading && (
                  <div className="generation-progress">
                    <Spin size="small" />
                    <Text type="secondary" className="generation-progress-text">
                      已生成 {generatedImages.length} / {generationCount}
                    </Text>
                  </div>
                )}
                <div className="generated-gallery" ref={galleryRef}
                  onTouchStart={handleGenGalleryTouchStart}
                  onTouchEnd={handleGenGalleryTouchEnd}>
                  <Image.PreviewGroup
                    items={generatedImages.map(img => img.displayUrl)}
                    preview={{
                      visible: previewVisible,
                      current: genPreviewIndex,
                      onVisibleChange: (visible) => setPreviewVisible(visible),
                      onChange: (current) => setGenPreviewIndex(current),
                    }}
                  >
                  {generatedImages.map((img) => (
                    <div key={img.id} className="polaroid-paper generated-paper">
                      <div style={{
                        position: 'relative',
                        paddingTop: '114.28%',
                        background: '#000',
                        width: '100%',
                        overflow: 'hidden',
                        boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.1)'
                      }}>
                        <div style={{
                          position: 'absolute',
                          top: 0, left: 0, right: 0, bottom: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          <PrivacyBlur enabled={config.privacyMode ?? false}>
                            <Image
                              src={img.displayUrl}
                              alt="Generated"
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              wrapperStyle={{ width: '100%', height: '100%' }}
                            />
                          </PrivacyBlur>
                        </div>
                      </div>
                      <div style={{
                        marginTop: 8,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        height: 24,
                        padding: '0 2px'
                      }}>
                        <Text style={{
                          fontSize: 12,
                          fontFamily: "'ZCOOL KuaiLe', cursive",
                          color: '#998888',
                          letterSpacing: '1px'
                        }}>
                          moe atelier
                        </Text>
                        <a
                          href={img.displayUrl}
                          download={`image-${img.localKey || img.id}.png`}
                          style={{ color: '#998888', fontSize: 14, display: 'flex' }}
                        >
                          <DownloadOutlined />
                        </a>
                      </div>
                    </div>
                  ))}
                  </Image.PreviewGroup>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ImageTask;
