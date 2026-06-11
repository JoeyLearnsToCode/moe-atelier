const normalizeText = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

const tryStringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

const normalizeForCompare = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

export const extractErrorDetail = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractErrorDetail(item);
      if (nested) return nested;
    }
    const serialized = tryStringify(value);
    return serialized || undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    record.detail,
    record.message,
    record.error_description,
    record.error,
    record.reason,
  ];

  for (const candidate of candidates) {
    const nested = extractErrorDetail(candidate);
    if (nested) return nested;
  }

  const serialized = tryStringify(value);
  return serialized || undefined;
};

export const formatHttpErrorMessage = ({
  status,
  statusText,
  body,
  fallback = '未知错误',
}: {
  status?: number;
  statusText?: string | null;
  body?: unknown;
  fallback?: string;
}) => {
  const detail = extractErrorDetail(body);
  const normalizedStatusText = normalizeText(statusText);
  const sameMessage =
    detail &&
    normalizedStatusText &&
    normalizeForCompare(detail) === normalizeForCompare(normalizedStatusText);

  const headline = normalizedStatusText || undefined;
  const suffix = detail && !sameMessage ? detail : undefined;
  const prefix = typeof status === 'number' ? `[${status}]` : '';

  if (prefix && headline && suffix) {
    return `${prefix} ${headline}: ${suffix}`;
  }
  if (prefix && headline) {
    return `${prefix} ${headline}`;
  }
  if (prefix && suffix) {
    return `${prefix} ${suffix}`;
  }
  if (headline && suffix) {
    return `${headline}: ${suffix}`;
  }
  if (headline) {
    return headline;
  }
  if (suffix) {
    return suffix;
  }
  if (prefix) {
    return `${prefix} ${fallback}`;
  }
  return fallback;
};

export const readResponseBodySafely = async (response: Response): Promise<unknown> => {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
};

export const formatResponseErrorMessage = async (
  response: Response,
  fallback = '未知错误',
) => {
  const body = await readResponseBodySafely(response);
  return formatHttpErrorMessage({
    status: response.status,
    statusText: response.statusText,
    body,
    fallback,
  });
};

export const formatUnknownErrorMessage = (error: unknown, fallback = '未知错误') => {
  if (!error) return fallback;
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed || fallback;
  }
  if (typeof error !== 'object') {
    return String(error);
  }

  const candidate = error as {
    message?: unknown;
    status?: unknown;
    statusText?: unknown;
    code?: unknown;
    cause?: unknown;
    response?: {
      status?: unknown;
      statusText?: unknown;
      data?: unknown;
    };
  };

  const codeText =
    typeof candidate.code === 'string' && candidate.code
      ? `[${candidate.code}]`
      : '';

  const causeText = (() => {
    if (!candidate.cause) return '';
    const detail = extractErrorDetail(candidate.cause);
    if (detail) return `(cause: ${detail})`;
    const str = tryStringify(candidate.cause);
    return str ? `(cause: ${str})` : '';
  })();

  if (candidate.response) {
    const status =
      typeof candidate.response.status === 'number'
        ? candidate.response.status
        : typeof candidate.status === 'number'
          ? candidate.status
          : undefined;
    const statusText =
      normalizeText(candidate.response.statusText) || normalizeText(candidate.statusText);
    const httpMsg = formatHttpErrorMessage({
      status,
      statusText,
      body: candidate.response.data,
      fallback:
        normalizeText(candidate.message) ||
        extractErrorDetail(candidate.response.data) ||
        fallback,
    });
    return [codeText, httpMsg, causeText].filter(Boolean).join(' ') || fallback;
  }

  const message = normalizeText(candidate.message);
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  const statusText = normalizeText(candidate.statusText);
  if (status || statusText) {
    const httpMsg = formatHttpErrorMessage({
      status,
      statusText,
      body: message || undefined,
      fallback,
    });
    return [codeText, httpMsg, causeText].filter(Boolean).join(' ') || fallback;
  }

  return [codeText, message, causeText].filter(Boolean).join(' ') || fallback;
};
