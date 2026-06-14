const MIN_BASE64_LENGTH = 256;
const BASE64_CONTENT_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const INLINE_IMAGE_DATA_REGEX =
  /(?:data:|[a-z0-9.+-]+:)?image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/i;

const normalizeBase64Payload = (value: string): string | null => {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < MIN_BASE64_LENGTH) return null;
  if (!BASE64_CONTENT_REGEX.test(compact)) return null;
  return compact;
};

const normalizeImageUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const imagePrefixMatch = trimmed.match(
    /^(?:[a-z0-9.+-]+:)?(image\/[a-z0-9.+-]+;base64,)([\s\S]+)$/i
  );
  if (imagePrefixMatch) {
    const payload = normalizeBase64Payload(imagePrefixMatch[2]);
    if (!payload) return null;
    return `data:${imagePrefixMatch[1]}${payload}`;
  }
  const base64Payload = normalizeBase64Payload(trimmed);
  if (base64Payload) {
    return `data:image/png;base64,${base64Payload}`;
  }
  return null;
};

const extractImageFromText = (text: string): string | null => {
  if (!text) return null;
  const mdImageRegex = /!\[[\s\S]*?\]\(([\s\S]*?)\)/;
  const match = text.match(mdImageRegex);
  if (match && match[1]) {
    const normalized = normalizeImageUrl(match[1]);
    if (normalized) return normalized;
  }
  const inlineMatch = text.match(INLINE_IMAGE_DATA_REGEX);
  if (inlineMatch) {
    const normalized = normalizeImageUrl(inlineMatch[0]);
    if (normalized) return normalized;
  }
  return normalizeImageUrl(text);
};

export const parseMarkdownImage = (text: string): string | null =>
  extractImageFromText(text);

const extractImageFromGeminiPart = (part: any): string | null => {
  if (!part) return null;
  const inlineData = part.inline_data || part.inlineData;
  const fileData = part.file_data || part.fileData;
  if (inlineData?.data) {
    const mimeType = inlineData.mime_type || inlineData.mimeType || 'image/png';
    const payload = normalizeBase64Payload(String(inlineData.data));
    if (payload) {
      return `data:${mimeType};base64,${payload}`;
    }
  }
  if (fileData?.file_uri || fileData?.fileUri) {
    const uri = fileData.file_uri || fileData.fileUri;
    const normalized = normalizeImageUrl(uri);
    if (normalized) return normalized;
  }
  if (typeof part.text === 'string') {
    const imageUrl = parseMarkdownImage(part.text);
    if (imageUrl) return imageUrl;
  }
  return null;
};

const extractImageFromGeminiCandidates = (candidates: any[]): string | null => {
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const image = extractImageFromGeminiPart(part);
        if (image) return image;
      }
    }
  }
  return null;
};

const extractImageFromMessage = (message: any): string | null => {
  if (!message) return null;
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === 'image_url') {
        const url = part?.image_url?.url || part?.image_url;
        if (url) {
          const normalized = normalizeImageUrl(url);
          if (normalized) return normalized;
        }
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        const imageUrl = parseMarkdownImage(part.text);
        if (imageUrl) return imageUrl;
      }
    }
  }
  if (typeof message.content === 'string') {
    const imageUrl = parseMarkdownImage(message.content);
    if (imageUrl) return imageUrl;
  }
  if (typeof message.reasoning_content === 'string') {
    const imageUrl = parseMarkdownImage(message.reasoning_content);
    if (imageUrl) return imageUrl;
  }
  return null;
};

export const resolveImageFromResponse = (data: any): string | null => {
  const resultUrl = data?.resultUrl ?? data?.result_url;
  if (typeof resultUrl === 'string') {
    const normalized = normalizeImageUrl(resultUrl);
    if (normalized) return normalized;
  }
  if (Array.isArray(data?.candidates)) {
    const image = extractImageFromGeminiCandidates(data.candidates);
    if (image) return image;
  }
  const fromDataArray = data?.data?.[0];
  if (fromDataArray) {
    if (typeof fromDataArray === 'string') {
      const normalized = normalizeImageUrl(fromDataArray);
      if (normalized) return normalized;
    }
    if (fromDataArray.b64_json) {
      const normalized = normalizeImageUrl(fromDataArray.b64_json);
      if (normalized) return normalized;
    }
    if (fromDataArray.url) {
      const normalized = normalizeImageUrl(fromDataArray.url);
      if (normalized) return normalized;
    }
  }
  return extractImageFromMessage(data?.choices?.[0]?.message);
};
