export type SafetySettings = Record<string, string>;

export interface ImageConfig {
  imageSize: string;
  aspectRatio: string;
}

export interface ApiProfile {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  apiFormat: 'openai' | 'gemini' | 'vertex' | 'openai-image';
  apiVersion: string;
  vertexProjectId?: string;
  vertexLocation?: string;
  vertexPublisher?: string;
  thinkingBudget: number;
  includeThoughts: boolean;
  includeImageConfig: boolean;
  includeSafetySettings: boolean;
  safety: SafetySettings;
  imageConfig: ImageConfig;
  webpQuality: number;
  useResponseModalities: boolean;
  customJson: string;
}

export interface AppConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  apiFormat: 'openai' | 'gemini' | 'vertex' | 'openai-image';
  apiVersion: string;
  vertexProjectId?: string;
  vertexLocation?: string;
  vertexPublisher?: string;
  stream: boolean;
  enableCollection: boolean;
  thinkingBudget: number;
  includeThoughts: boolean;
  includeImageConfig: boolean;
  includeSafetySettings: boolean;
  safety: SafetySettings;
  imageConfig: ImageConfig;
  webpQuality: number;
  useResponseModalities: boolean;
  customJson: string;

  privacyMode?: boolean;
  skipDownloadedInDownloadAll?: boolean;

  apiProfiles?: ApiProfile[];
  activeApiProfileId?: string;
}

export interface TaskConfig {
  id: string;
  prompt: string;
  imageUrl?: string;
}
