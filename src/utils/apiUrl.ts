export type ApiFormat = 'openai' | 'gemini' | 'vertex' | 'openai-image';

export const API_VERSION_OPTIONS = ['v1', 'v1beta', 'v1beta1'];

export const DEFAULT_API_BASES: Record<ApiFormat, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-image': 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  vertex: 'https://aiplatform.googleapis.com',
};

const VERSION_REGEX = /^v1(?:beta1|beta)?$/i;
const MARKER_SEGMENTS = new Set(['projects', 'locations', 'publishers', 'models']);

const ensureProtocol = (value: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

const trimUrl = (value: string) => value.trim().replace(/\/+$/, '');

export const resolveApiUrl = (apiUrl: string | undefined, apiFormat: ApiFormat) => {
  const trimmed = typeof apiUrl === 'string' ? apiUrl.trim() : '';
  return trimmed || DEFAULT_API_BASES[apiFormat];
};

export const inferApiVersionFromUrl = (apiUrl: string): string | null => {
  const cleaned = trimUrl(apiUrl);
  if (!cleaned) return null;
  try {
    const url = new URL(ensureProtocol(cleaned));
    const segments = url.pathname.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i];
      if (VERSION_REGEX.test(segment)) return segment;
    }
    return null;
  } catch {
    const segments = cleaned.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i];
      if (VERSION_REGEX.test(segment)) return segment;
    }
    return null;
  }
};

export const normalizeApiBase = (apiUrl: string) => {
  const cleaned = trimUrl(apiUrl);
  if (!cleaned) {
    return { origin: '', segments: [] as string[], host: '' };
  }
  try {
    const url = new URL(ensureProtocol(cleaned));
    return {
      origin: `${url.protocol}//${url.host}`,
      segments: url.pathname.split('/').filter(Boolean),
      host: url.host.toLowerCase(),
    };
  } catch {
    return { origin: cleaned, segments: [] as string[], host: '' };
  }
};

export const resolveApiVersion = (
  apiUrl: string,
  apiVersion: string | undefined,
  fallback: string,
) => {
  const inferred = inferApiVersionFromUrl(apiUrl);
  if (inferred) return inferred;
  const trimmed = apiVersion?.trim();
  return trimmed || fallback;
};

export const extractVertexProjectId = (apiUrl: string): string | null => {
  const { segments } = normalizeApiBase(apiUrl);
  const index = segments.indexOf('projects');
  if (index < 0) return null;
  const candidate = segments[index + 1];
  if (!candidate) return null;
  if (MARKER_SEGMENTS.has(candidate)) return null;
  if (VERSION_REGEX.test(candidate)) return null;
  return candidate;
};
