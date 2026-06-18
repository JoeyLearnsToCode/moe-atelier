import { v4 as uuidv4 } from 'uuid';
import type { AppConfig, TaskConfig } from '../types/app';
import type { CollectionItem } from '../types/collection';
import type { GlobalStats } from '../types/stats';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '../utils/storage';
import { openImageDb, IMAGE_STORE_NAME } from '../utils/imageDb';
import { buildPromptKey } from '../utils/prompt';

export const STORAGE_KEYS = {
  config: 'moe-image-config',
  configByFormat: 'moe-image-config-by-format',
  tasks: 'moe-image-tasks',
  globalStats: 'moe-image-global-stats',
  collection: 'moe-image-collection',
  lastDownloadTime: 'moe-image-last-download-time',
};

const TASK_STORAGE_PREFIX = 'moe-image-task:';

type ApiFormat = AppConfig['apiFormat'];

export type FormatConfig = Pick<
  AppConfig,
  | 'apiUrl'
  | 'apiKey'
  | 'model'
  | 'apiVersion'
  | 'vertexProjectId'
  | 'vertexLocation'
  | 'vertexPublisher'
  | 'thinkingBudget'
  | 'includeThoughts'
  | 'includeImageConfig'
  | 'includeSafetySettings'
  | 'safety'
  | 'imageConfig'
  | 'webpQuality'
  | 'useResponseModalities'
  | 'customJson'
>;

const createDefaultSafetySettings = () => ({
  HARM_CATEGORY_HARASSMENT: 'OFF',
  HARM_CATEGORY_HATE_SPEECH: 'OFF',
  HARM_CATEGORY_SEXUALLY_EXPLICIT: 'OFF',
  HARM_CATEGORY_DANGEROUS_CONTENT: 'OFF',
  HARM_CATEGORY_CIVIC_INTEGRITY: 'BLOCK_NONE',
});

const createDefaultImageConfig = () => ({
  imageSize: '2K',
  aspectRatio: 'auto',
});

const createDefaultAdvancedConfig = () => ({
  thinkingBudget: 128,
  includeThoughts: true,
  includeImageConfig: true,
  includeSafetySettings: true,
  safety: createDefaultSafetySettings(),
  imageConfig: createDefaultImageConfig(),
  webpQuality: 95,
  useResponseModalities: false,
  customJson: '',
});

const DEFAULT_FORMAT_CONFIGS: Record<ApiFormat, FormatConfig> = {
  openai: {
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    apiVersion: 'v1',
    vertexProjectId: '',
    vertexLocation: 'global',
    vertexPublisher: 'google',
    ...createDefaultAdvancedConfig(),
  },
  'openai-image': {
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    apiVersion: 'v1',
    vertexProjectId: '',
    vertexLocation: 'global',
    vertexPublisher: 'google',
    ...createDefaultAdvancedConfig(),
  },
  'openai-hybrid': {
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    apiVersion: 'v1',
    vertexProjectId: '',
    vertexLocation: 'global',
    vertexPublisher: 'google',
    ...createDefaultAdvancedConfig(),
  },
  gemini: {
    apiUrl: 'https://generativelanguage.googleapis.com',
    apiKey: '',
    model: '',
    apiVersion: 'v1beta',
    vertexProjectId: '',
    vertexLocation: 'global',
    vertexPublisher: 'google',
    ...createDefaultAdvancedConfig(),
  },
  vertex: {
    apiUrl: 'https://aiplatform.googleapis.com',
    apiKey: '',
    model: '',
    apiVersion: 'v1beta1',
    vertexProjectId: '',
    vertexLocation: 'us-central1',
    vertexPublisher: 'google',
    ...createDefaultAdvancedConfig(),
  },
};

const DEFAULT_CONFIG: AppConfig = {
  ...DEFAULT_FORMAT_CONFIGS.openai,
  apiFormat: 'openai',
  stream: false,
  enableCollection: true,
  privacyMode: false,
  skipDownloadedInDownloadAll: true,
  defaultRetryInterval: 1,
  defaultRetryLimit: -1,
  defaultGenerationCount: 1,
  defaultApiProfileId: 'default',
};

const DEFAULT_GLOBAL_STATS: GlobalStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};

const coerceConfigString = (value: unknown) => (typeof value === 'string' ? value : '');
const coerceBoolean = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback;
const coerceNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const coerceThinkingBudget = (value: unknown) =>
  clampNumber(Math.round(coerceNumber(value, 128)), 0, 8192);

const coerceWebpQuality = (value: unknown) =>
  clampNumber(Math.round(coerceNumber(value, 95)), 50, 100);

const coerceSafetySettings = (value: unknown) => {
  const next = createDefaultSafetySettings();
  if (!value || typeof value !== 'object') return next;
  const raw = value as Record<string, unknown>;
  const safetyKeys = Object.keys(next) as Array<keyof typeof next>;
  safetyKeys.forEach((key) => {
    const rawValue = raw[key];
    if (typeof rawValue === 'string') {
      next[key] = rawValue;
    }
  });
  return next;
};

const coerceImageConfig = (value: unknown) => {
  if (!value || typeof value !== 'object') return createDefaultImageConfig();
  const raw = value as Record<string, unknown>;
  const imageSize =
    typeof raw.imageSize === 'string'
      ? raw.imageSize
      : typeof raw.imagesize === 'string'
        ? raw.imagesize
        : '2K';
  const aspectRatio = typeof raw.aspectRatio === 'string' ? raw.aspectRatio : 'auto';
  return { imageSize, aspectRatio };
};

export const buildFormatConfig = (value: Partial<AppConfig> = {}): FormatConfig => ({
  apiUrl: coerceConfigString(value.apiUrl),
  apiKey: coerceConfigString(value.apiKey),
  model: coerceConfigString(value.model),
  apiVersion: coerceConfigString(value.apiVersion),
  vertexProjectId: coerceConfigString(value.vertexProjectId),
  vertexLocation: coerceConfigString(value.vertexLocation),
  vertexPublisher: coerceConfigString(value.vertexPublisher),
  thinkingBudget: coerceThinkingBudget(value.thinkingBudget),
  includeThoughts: coerceBoolean(value.includeThoughts, true),
  includeImageConfig: coerceBoolean(value.includeImageConfig, true),
  includeSafetySettings: coerceBoolean(value.includeSafetySettings, true),
  safety: coerceSafetySettings(value.safety),
  imageConfig: coerceImageConfig(value.imageConfig),
  webpQuality: coerceWebpQuality(value.webpQuality),
  useResponseModalities: coerceBoolean(value.useResponseModalities, false),
  customJson: coerceConfigString(value.customJson),
});

export const getDefaultFormatConfig = (apiFormat: ApiFormat): FormatConfig =>
  buildFormatConfig(DEFAULT_FORMAT_CONFIGS[apiFormat]);

const loadFormatConfigMap = (): Partial<Record<ApiFormat, Partial<FormatConfig>>> => {
  const raw = safeStorageGet(STORAGE_KEYS.configByFormat, 'app cache');
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return {};
    return data as Record<ApiFormat, Partial<FormatConfig>>;
  } catch (err) {
    console.warn('Failed to parse config-by-format cache:', err);
    return {};
  }
};

export const loadConfig = (): AppConfig => {
  const raw = safeStorageGet(STORAGE_KEYS.config, 'app cache');
  const formatMap = loadFormatConfigMap();
  if (!raw) {
    const formatConfig = loadFormatConfig(DEFAULT_CONFIG.apiFormat);
    const finalConfig = { ...DEFAULT_CONFIG, ...formatConfig };
    if (!finalConfig.apiProfiles || finalConfig.apiProfiles.length === 0) {
      finalConfig.apiProfiles = [{
        id: 'default',
        name: '默认配置',
        apiUrl: finalConfig.apiUrl,
        apiKey: finalConfig.apiKey,
        model: finalConfig.model,
        apiFormat: finalConfig.apiFormat,
        apiVersion: finalConfig.apiVersion,
        vertexProjectId: finalConfig.vertexProjectId,
        vertexLocation: finalConfig.vertexLocation,
        vertexPublisher: finalConfig.vertexPublisher,
        thinkingBudget: finalConfig.thinkingBudget,
        includeThoughts: finalConfig.includeThoughts,
        includeImageConfig: finalConfig.includeImageConfig,
        includeSafetySettings: finalConfig.includeSafetySettings,
        safety: finalConfig.safety,
        imageConfig: finalConfig.imageConfig,
        webpQuality: finalConfig.webpQuality,
        useResponseModalities: finalConfig.useResponseModalities,
        customJson: finalConfig.customJson,
      }];
      finalConfig.activeApiProfileId = 'default';
    }
    return finalConfig;
  }
  try {
    const data = JSON.parse(raw);
    const baseConfig = { ...DEFAULT_CONFIG, ...data };
    const apiFormat = (baseConfig.apiFormat || DEFAULT_CONFIG.apiFormat) as ApiFormat;
    const storedFormat = formatMap?.[apiFormat];
    const hasLegacyFormatFields = [
      'apiUrl',
      'apiKey',
      'model',
      'apiVersion',
      'vertexProjectId',
      'vertexLocation',
      'vertexPublisher',
      'thinkingBudget',
      'includeThoughts',
      'includeImageConfig',
      'includeSafetySettings',
      'safety',
      'imageConfig',
      'webpQuality',
      'useResponseModalities',
      'customJson',
    ].some((key) => Object.prototype.hasOwnProperty.call(data, key));
    const fallbackFormat = storedFormat
      ? buildFormatConfig(storedFormat as Partial<AppConfig>)
      : hasLegacyFormatFields
        ? buildFormatConfig(baseConfig)
        : DEFAULT_FORMAT_CONFIGS[apiFormat];
    const formatConfig = {
      ...DEFAULT_FORMAT_CONFIGS[apiFormat],
      ...fallbackFormat,
    };
    const finalConfig = { ...baseConfig, ...formatConfig, apiFormat };
    if (!finalConfig.apiProfiles || finalConfig.apiProfiles.length === 0) {
      finalConfig.apiProfiles = [{
        id: 'default',
        name: '默认配置',
        apiUrl: finalConfig.apiUrl,
        apiKey: finalConfig.apiKey,
        model: finalConfig.model,
        apiFormat: finalConfig.apiFormat,
        apiVersion: finalConfig.apiVersion,
        vertexProjectId: finalConfig.vertexProjectId,
        vertexLocation: finalConfig.vertexLocation,
        vertexPublisher: finalConfig.vertexPublisher,
        thinkingBudget: finalConfig.thinkingBudget,
        includeThoughts: finalConfig.includeThoughts,
        includeImageConfig: finalConfig.includeImageConfig,
        includeSafetySettings: finalConfig.includeSafetySettings,
        safety: finalConfig.safety,
        imageConfig: finalConfig.imageConfig,
        webpQuality: finalConfig.webpQuality,
        useResponseModalities: finalConfig.useResponseModalities,
        customJson: finalConfig.customJson,
      }];
      finalConfig.activeApiProfileId = 'default';
    }
    return finalConfig;
  } catch (err) {
    console.warn('Failed to parse config cache:', err);
    return { ...DEFAULT_CONFIG };
  }
};

export const loadFormatConfig = (apiFormat: ApiFormat): FormatConfig => {
  const formatMap = loadFormatConfigMap();
  const stored = formatMap?.[apiFormat];
  const resolved = stored
    ? buildFormatConfig(stored as Partial<AppConfig>)
    : DEFAULT_FORMAT_CONFIGS[apiFormat];
  return { ...DEFAULT_FORMAT_CONFIGS[apiFormat], ...resolved };
};

export const saveConfig = (config: AppConfig) => {
  const baseConfig = {
    apiFormat: config.apiFormat,
    stream: config.stream,
    enableCollection: config.enableCollection,
    privacyMode: config.privacyMode,
    skipDownloadedInDownloadAll: config.skipDownloadedInDownloadAll,
    apiProfiles: config.apiProfiles,
    activeApiProfileId: config.activeApiProfileId,
    defaultRetryInterval: config.defaultRetryInterval,
    defaultRetryLimit: config.defaultRetryLimit,
    defaultGenerationCount: config.defaultGenerationCount,
    defaultApiProfileId: config.defaultApiProfileId,
  };
  safeStorageSet(STORAGE_KEYS.config, JSON.stringify(baseConfig), 'app cache');
  const formatMap = loadFormatConfigMap();
  formatMap[config.apiFormat] = buildFormatConfig(config);
  safeStorageSet(
    STORAGE_KEYS.configByFormat,
    JSON.stringify(formatMap),
    'app cache',
  );
};

export const loadGlobalStats = (): GlobalStats => {
  const raw = safeStorageGet(STORAGE_KEYS.globalStats, 'app cache');
  if (!raw) return { ...DEFAULT_GLOBAL_STATS };
  try {
    const data = JSON.parse(raw);
    return { ...DEFAULT_GLOBAL_STATS, ...data };
  } catch (err) {
    console.warn('Failed to parse stats cache:', err);
    return { ...DEFAULT_GLOBAL_STATS };
  }
};

export const loadTasks = (): TaskConfig[] => {
  const raw = safeStorageGet(STORAGE_KEYS.tasks, 'app cache');
  if (!raw) return [{ id: uuidv4(), prompt: '' }];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return [{ id: uuidv4(), prompt: '' }];
    }
    const uniqueIds = Array.from(
      new Set(data.filter((item: unknown) => typeof item === 'string')),
    );
    if (uniqueIds.length === 0) {
      return [{ id: uuidv4(), prompt: '' }];
    }
    return uniqueIds.map((id) => ({ id, prompt: '' }));
  } catch (err) {
    console.warn('Failed to parse tasks cache:', err);
    return [{ id: uuidv4(), prompt: '' }];
  }
};

export const getTaskStorageKey = (id: string) => `${TASK_STORAGE_PREFIX}${id}`;

const getTaskImageKeys = (storageKey: string) => {
  const raw = safeStorageGet(storageKey, 'app cache');
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as {
      results?: Array<{ id?: string; localKey?: string }>;
      uploads?: Array<{ localKey?: string }>;
    };
    const resultKeys = Array.isArray(data?.results)
      ? data.results
          .map((item) => item?.localKey || item?.id)
          .filter((key): key is string => typeof key === 'string')
      : [];
    const uploadKeys = Array.isArray(data?.uploads)
      ? data.uploads
          .map((item) => item?.localKey)
          .filter((key): key is string => typeof key === 'string')
      : [];
    return Array.from(new Set([...resultKeys, ...uploadKeys]));
  } catch (err) {
    console.warn('Failed to parse task cache for cleanup:', err);
    return [];
  }
};

const deleteImageBlobs = async (keys: string[]) => {
  if (keys.length === 0 || typeof indexedDB === 'undefined') return;
  try {
    const db = await openImageDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      keys.forEach((key) => store.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to remove image cache:', err);
  }
};

export const deleteImageCache = async (key: string) => {
  await deleteImageBlobs([key]);
};

type CleanupTaskCacheOptions = {
  preserveImageKeys?: Iterable<string>;
};

export const cleanupTaskCache = async (
  storageKey: string,
  options: CleanupTaskCacheOptions = {},
) => {
  const keys = getTaskImageKeys(storageKey);
  const preserveSet = options.preserveImageKeys
    ? new Set(options.preserveImageKeys)
    : null;
  const keysToDelete = preserveSet
    ? keys.filter((key) => !preserveSet.has(key))
    : keys;
  await deleteImageBlobs(keysToDelete);
  safeStorageRemove(storageKey, 'app cache');
};

const listImageBlobKeys = async (): Promise<string[]> => {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const db = await openImageDb();
    return await new Promise<string[]>((resolve) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        resolve(
          Array.isArray(request.result)
            ? (request.result as string[])
            : [],
        );
      };
      request.onerror = () => resolve([]);
    });
  } catch (err) {
    console.warn('Failed to list image cache keys:', err);
    return [];
  }
};

export const collectTaskImageKeys = (taskIds: string[]) => {
  const keys = new Set<string>();
  taskIds.forEach((taskId) => {
    const storageKey = getTaskStorageKey(taskId);
    getTaskImageKeys(storageKey).forEach((key) => keys.add(key));
  });
  return Array.from(keys);
};

export const cleanupUnusedImageCache = async (keepKeys: Iterable<string>) => {
  const keepSet = new Set(keepKeys);
  const allKeys = await listImageBlobKeys();
  const keysToDelete = allKeys.filter((key) => !keepSet.has(String(key)));
  await deleteImageBlobs(keysToDelete);
};

const coerceString = (value: unknown) => (typeof value === 'string' ? value : '');

const sanitizeCollectionItem = (value: unknown): CollectionItem | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = coerceString(raw.id);
  if (!id) return null;
  const prompt = coerceString(raw.prompt);
  const taskId = coerceString(raw.taskId);
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();
  const image = typeof raw.image === 'string' ? raw.image : undefined;
  const localKey = typeof raw.localKey === 'string' ? raw.localKey : undefined;
  const sourceSignature =
    typeof raw.sourceSignature === 'string' ? raw.sourceSignature : undefined;
  const item: CollectionItem = {
    id,
    prompt,
    taskId,
    timestamp,
  };
  if (image) {
    item.image = image;
  }
  if (localKey) {
    item.localKey = localKey;
  }
  if (sourceSignature) {
    item.sourceSignature = sourceSignature;
  }
  return item;
};

const isEphemeralImage = (value?: string) =>
  Boolean(value && (value.startsWith('data:image') || value.startsWith('blob:')));

const shouldStripInlineImage = (item: CollectionItem) =>
  Boolean(item.localKey && isEphemeralImage(item.image));

const isUploadCollectionKey = (key?: string) =>
  Boolean(key && key.startsWith('collection:upload:'));

const getCollectionDedupKey = (item: CollectionItem) => {
  if (
    item.sourceSignature &&
    (isUploadCollectionKey(item.id) || isUploadCollectionKey(item.localKey))
  ) {
    return `upload:${buildPromptKey(item.prompt)}:${item.sourceSignature}`;
  }
  return item.localKey || item.image || item.id;
};

export const loadCollectionItems = (): CollectionItem[] => {
  const raw = safeStorageGet(STORAGE_KEYS.collection, 'collection cache');
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const items: CollectionItem[] = [];
    const seen = new Set<string>();
    data.forEach((entry) => {
      const item = sanitizeCollectionItem(entry);
      if (!item) return;
      const key = getCollectionDedupKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    });
    return items;
  } catch (err) {
    console.warn('Failed to parse collection cache:', err);
    return [];
  }
};

export const loadLastDownloadTime = (): number | null => {
  const raw = safeStorageGet(STORAGE_KEYS.lastDownloadTime);
  if (!raw) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
};

export const saveLastDownloadTime = (timestamp: number) => {
  safeStorageSet(STORAGE_KEYS.lastDownloadTime, String(timestamp));
};

export const saveCollectionItems = (items: CollectionItem[]) => {
  const payload = items.map((item) => {
    if (!shouldStripInlineImage(item)) return item;
    const { image, ...rest } = item;
    return rest;
  });
  safeStorageSet(STORAGE_KEYS.collection, JSON.stringify(payload), 'collection cache');
};
