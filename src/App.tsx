import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import { Layout, Button, Form, Row, Col, Typography, Space, ConfigProvider, message, Tooltip } from 'antd';
import { 
  PlusOutlined, 
  SettingFilled, 
  ThunderboltFilled, 
  CheckCircleFilled, 
  HeartFilled,
  AppstoreFilled,
  DeleteFilled,
  RocketFilled,
  HourglassFilled,
  DashboardFilled,
  TrophyFilled,
  DownloadOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import PromptDrawer from './components/PromptDrawer';
import CollectionBox from './components/CollectionBox';
import TaskGrid from './components/TaskGrid';
import ConfigDrawer from './components/ConfigDrawer';
import type { AppConfig, TaskConfig } from './types/app';
import type { CollectionItem } from './types/collection';
import type { GlobalStats } from './types/stats';
import type { PersistedUploadImage } from './types/imageTask';
import type { LogEntry } from './types/log';
import {
  cleanupTaskCache,
  cleanupUnusedImageCache,
  collectTaskImageKeys,
  deleteImageCache,
  getTaskStorageKey,
  loadCollectionItems,
  loadConfig,
  saveCollectionItems,
  loadFormatConfig,
  loadGlobalStats,
  loadTasks,
  saveConfig,
  STORAGE_KEYS,
} from './app/storage';
import {
  extractVertexProjectId,
  inferApiVersionFromUrl,
  normalizeApiBase,
  resolveApiUrl,
  resolveApiVersion,
} from './utils/apiUrl';
import { safeStorageSet } from './utils/storage';
import { calculateSuccessRate, formatDuration } from './utils/stats';
import { TASK_STATE_VERSION, saveTaskState, DEFAULT_TASK_STATS } from './components/imageTaskState';
import {
  buildBatchDownloadZip,
  buildZipFilename,
  downloadBlob,
} from './utils/batchDownload';

const { Header, Content } = Layout;
const { Title, Text } = Typography;
const EMPTY_GLOBAL_STATS: GlobalStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};


function App() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [tasks, setTasks] = useState<TaskConfig[]>(() => loadTasks());
  const [globalStats, setGlobalStats] = useState<GlobalStats>(() => loadGlobalStats());
  const [configVisible, setConfigVisible] = useState(false);
  const [collectionVisible, setCollectionVisible] = useState(false);
  const [collectedItems, setCollectedItems] = useState<CollectionItem[]>(() => loadCollectionItems());
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [promptDrawerVisible, setPromptDrawerVisible] = useState(false);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [models, setModels] = useState<{label: string, value: string}[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ current: number; total: number } | null>(null);
  const [form] = Form.useForm();
  const configRef = useRef(config);
  const collectedItemsRef = useRef(collectedItems);
  const collectionCountRef = useRef(collectedItems.length);

  React.useEffect(() => {
    configRef.current = config;
  }, [config]);

  React.useEffect(() => {
    if (!configVisible) return;
    form.setFieldsValue(config);
  }, [configVisible, config, form]);

  React.useEffect(() => {
    collectedItemsRef.current = collectedItems;
  }, [collectedItems]);

  React.useEffect(() => {
    if (collectionCountRef.current > collectedItems.length) {
      setCollectionRevision((prev) => prev + 1);
    }
    collectionCountRef.current = collectedItems.length;
  }, [collectedItems.length]);

  React.useEffect(() => {
    if (!collectionVisible) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.collection-drawer') && !target.closest('.ant-image-preview-root')) {
        setCollectionVisible(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [collectionVisible]);

  React.useEffect(() => {
    if (config.enableCollection) return;
    const keepKeys = collectTaskImageKeys(tasks.map((task) => task.id));
    void cleanupUnusedImageCache(keepKeys);
  }, [config.enableCollection, tasks]);

  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    navigator.storage.persist().catch(() => undefined);
  }, []);

  React.useEffect(() => {
    saveConfig(config);
  }, [config]);

  React.useEffect(() => {
    safeStorageSet(
      STORAGE_KEYS.tasks,
      JSON.stringify(tasks.map((task: TaskConfig) => task.id)),
      'app cache',
    );
  }, [tasks]);

  React.useEffect(() => {
    safeStorageSet(
      STORAGE_KEYS.globalStats,
      JSON.stringify(globalStats),
      'app cache',
    );
  }, [globalStats]);

  React.useEffect(() => {
    saveCollectionItems(collectedItems);
  }, [collectedItems]);

  const fetchModels = async () => {
    const currentConfig = form.getFieldsValue();
    if (!currentConfig.apiKey) {
      message.warning('请先填写 API 密钥');
      return;
    }

    setLoadingModels(true);
    try {
      const apiFormat = currentConfig.apiFormat || 'openai';
      const apiUrl = resolveApiUrl(currentConfig.apiUrl, apiFormat);
      const versionFallback =
        apiFormat === 'openai' ? 'v1' : apiFormat === 'vertex' ? 'v1beta1' : 'v1beta';
      const version = resolveApiVersion(
        apiUrl,
        currentConfig.apiVersion,
        versionFallback,
      );
      const baseInfo = normalizeApiBase(apiUrl);
      const basePath = baseInfo.origin
        ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
        : apiUrl.replace(/\/+$/, '');

      let url = '';
      const headers: Record<string, string> = {};

      if (apiFormat === 'openai') {
        const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
        const openAiBase = hasVersion ? basePath : `${basePath}/${version}`;
        url = openAiBase.endsWith('/models') ? openAiBase : `${openAiBase}/models`;
        headers.Authorization = `Bearer ${currentConfig.apiKey}`;
      } else if (apiFormat === 'gemini') {
        const segments = [...baseInfo.segments];
        if (!inferApiVersionFromUrl(apiUrl)) {
          const modelIndex = segments.indexOf('models');
          if (modelIndex >= 0) {
            segments.splice(modelIndex, 0, version);
          } else {
            segments.push(version);
          }
        }
        const modelIndex = segments.indexOf('models');
        if (modelIndex >= 0) {
          segments.splice(modelIndex + 1);
        } else {
          segments.push('models');
        }
        const geminiBase = baseInfo.origin
          ? `${baseInfo.origin}/${segments.join('/')}`
          : `${segments.join('/')}`;
        const isOfficial = baseInfo.host === 'generativelanguage.googleapis.com';
        if (isOfficial) {
          url = `${geminiBase}?key=${encodeURIComponent(currentConfig.apiKey)}`;
        } else {
          url = geminiBase;
          headers.Authorization = `Bearer ${currentConfig.apiKey}`;
        }
      } else {
        message.warning('Vertex 模型列表暂不支持自动获取');
        return;
      }

      const res = await fetch(url, { headers });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const data = await res.json();
      if (apiFormat === 'openai') {
        const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
        if (list.length === 0) {
          throw new Error('返回数据格式不正确');
        }
        const modelOptions = list
          .map((m: any) => ({ label: m.id || m.name, value: m.id || m.name }))
          .filter((item: any) => typeof item.value === 'string')
          .sort((a: any, b: any) => a.value.localeCompare(b.value));
        setModels(modelOptions);
        message.success(`成功获取 ${modelOptions.length} 个模型`);
      } else {
        const list = Array.isArray(data.models)
          ? data.models
          : Array.isArray(data.data)
            ? data.data
            : [];
        if (list.length === 0) {
          throw new Error('返回数据格式不正确');
        }
        const modelOptions = list
          .map((m: any) => {
            const rawName =
              typeof m?.name === 'string' ? m.name : typeof m?.id === 'string' ? m.id : '';
            const name = rawName.replace(/^models\//, '');
            return name ? { label: name, value: name } : null;
          })
          .filter((item: any) => item && item.value)
          .sort((a: any, b: any) => a.value.localeCompare(b.value));
        setModels(modelOptions);
        message.success(`成功获取 ${modelOptions.length} 个模型`);
      }
    } catch (e) {
      console.error(e);
      message.error('获取模型列表失败，请检查配置');
    } finally {
      setLoadingModels(false);
    }
  };

  // 当配置抽屉打开且有 API Key 时，如果列表为空，自动获取一次
  React.useEffect(() => {
    if (configVisible && config.apiKey && models.length === 0) {
      fetchModels();
    }
  }, [configVisible]);

  const handleAddTask = () => {
    const newTaskId = uuidv4();
    setTasks([{ id: newTaskId, prompt: '' }, ...tasks]);
  };

  const handleReorderTasks = useCallback((nextTasks: TaskConfig[]) => {
    setTasks(nextTasks);
  }, []);

  const handleCreateTaskFromPrompt = (prompt: string) => {
    const newTaskId = uuidv4();
    const storageKey = getTaskStorageKey(newTaskId);
    saveTaskState(storageKey, {
      version: TASK_STATE_VERSION,
      prompt: prompt,
      concurrency: 2,
      enableSound: true,
      retryInterval: 1000,
      retryLimit: -1,
      generationCount: 1,
      results: [],
      uploads: [],
      stats: DEFAULT_TASK_STATS,
    }).catch((err) => console.warn('Failed to persist task state:', err));

    setTasks([{ id: newTaskId, prompt }, ...tasks]);
  };

  const handleCreateTaskFromCollection = (prompt: string, referenceImages: CollectionItem[]) => {
    const newTaskId = uuidv4();
    
    const uploads: PersistedUploadImage[] = referenceImages
      .filter((img) => img.localKey)
      .map((img) => {
        const uid = uuidv4();
        return {
          uid,
          name: `reference-${uid.slice(0, 8)}.png`,
          type: 'image/png',
          localKey: img.localKey as string,
          lastModified: Date.now(),
          fromCollection: true,
          sourceSignature: img.sourceSignature,
        };
      });

    const storageKey = getTaskStorageKey(newTaskId);
    saveTaskState(storageKey, {
      version: TASK_STATE_VERSION,
      prompt: prompt,
      concurrency: 2,
      enableSound: true,
      retryInterval: 1000,
      retryLimit: -1,
      generationCount: 1,
      results: [],
      uploads: uploads,
      stats: DEFAULT_TASK_STATS,
    }).catch((err) => console.warn('Failed to persist task state:', err));

    setTasks([{ id: newTaskId, prompt }, ...tasks]);
    setCollectionVisible(false);
    message.success('已创建新任务');
  };

  const isCollectionCacheKey = (key: string) => key.startsWith('collection:');

  const handleRemoveTask = (id: string) => {
    const storageKey = getTaskStorageKey(id);
    const preserveKeys = config.enableCollection
      ? collectedItems
          .filter(
            (item) =>
              item.taskId === id &&
              typeof item.localKey === 'string' &&
              !isCollectionCacheKey(item.localKey),
          )
          .map((item) => item.localKey as string)
      : [];
    if (preserveKeys.length > 0) {
      void cleanupTaskCache(storageKey, { preserveImageKeys: preserveKeys });
    } else {
      void cleanupTaskCache(storageKey);
    }
    setTasks(tasks.filter((t: TaskConfig) => t.id !== id));
  };

  const handleConfigChange = (changedValues: any, allValues: AppConfig) => {
    let nextConfig = { ...config, ...allValues };

    if (changedValues.activeApiProfileId && changedValues.activeApiProfileId !== config.activeApiProfileId) {
      const selectedProfile = nextConfig.apiProfiles?.find(p => p.id === changedValues.activeApiProfileId);
      if (selectedProfile) {
        const { id, name, ...profileFields } = selectedProfile;
        nextConfig = { ...nextConfig, ...profileFields };
        form.setFieldsValue(profileFields);
        changedValues.apiFormat = selectedProfile.apiFormat; // Trigger format config load if format differs
      }
    } else if (!changedValues.apiProfiles) {
      // Normal field change, sync to active profile
      const profileKeys = ['apiUrl', 'apiKey', 'model', 'apiFormat', 'apiVersion', 'vertexProjectId', 'vertexLocation', 'vertexPublisher', 'thinkingBudget', 'includeThoughts', 'includeImageConfig', 'includeSafetySettings', 'safety', 'imageConfig', 'webpQuality', 'useResponseModalities', 'customJson'];
      const isProfileFieldChanged = Object.keys(changedValues).some(k => profileKeys.includes(k));
      if (isProfileFieldChanged && nextConfig.apiProfiles) {
        nextConfig.apiProfiles = nextConfig.apiProfiles.map(p => 
          p.id === nextConfig.activeApiProfileId 
            ? { ...p, ...profileKeys.reduce((acc, key) => ({ ...acc, [key]: (nextConfig as any)[key] }), {}) }
            : p
        );
      }
    }

    const nextFormat = nextConfig.apiFormat || config.apiFormat;
    nextConfig.apiFormat = nextFormat;

    const formatChanged =
      typeof changedValues?.apiFormat === 'string' &&
      changedValues.apiFormat !== config.apiFormat;

    if (formatChanged && !changedValues.activeApiProfileId) {
      const formatConfig = loadFormatConfig(nextFormat);
      nextConfig = { ...nextConfig, ...formatConfig, apiFormat: nextFormat };
      form.setFieldsValue({
        apiUrl: formatConfig.apiUrl,
        apiKey: formatConfig.apiKey,
        model: formatConfig.model,
        apiVersion: formatConfig.apiVersion,
        vertexProjectId: formatConfig.vertexProjectId,
        vertexLocation: formatConfig.vertexLocation,
        vertexPublisher: formatConfig.vertexPublisher,
        thinkingBudget: formatConfig.thinkingBudget,
        includeThoughts: formatConfig.includeThoughts,
        includeImageConfig: formatConfig.includeImageConfig,
        includeSafetySettings: formatConfig.includeSafetySettings,
        safety: formatConfig.safety,
        imageConfig: formatConfig.imageConfig,
        webpQuality: formatConfig.webpQuality,
        useResponseModalities: formatConfig.useResponseModalities,
        customJson: formatConfig.customJson,
      });
      setModels([]);
    }

    if (typeof nextConfig.apiUrl === 'string') {
      const inferredVersion = inferApiVersionFromUrl(nextConfig.apiUrl);
      if (inferredVersion && inferredVersion !== nextConfig.apiVersion) {
        nextConfig.apiVersion = inferredVersion;
        form.setFieldsValue({ apiVersion: inferredVersion });
      }
      if (nextFormat === 'vertex') {
        const inferredProjectId = extractVertexProjectId(nextConfig.apiUrl);
        if (inferredProjectId && inferredProjectId !== nextConfig.vertexProjectId) {
          nextConfig.vertexProjectId = inferredProjectId;
          form.setFieldsValue({ vertexProjectId: inferredProjectId });
        }
      }
    }

    setConfig(nextConfig);
  };

  const normalizePrompt = (prompt: string) =>
    prompt.trim().replace(/\s+/g, ' ');

  const buildPromptKey = (prompt: string) => {
    const normalized = normalizePrompt(prompt);
    return normalized ? normalized.toLowerCase() : '__empty__';
  };

  const isUploadCollectionKey = (key?: string) =>
    Boolean(key && key.startsWith('collection:upload:'));

  const isUploadCollectionItem = (item: CollectionItem) =>
    isUploadCollectionKey(item.id) || isUploadCollectionKey(item.localKey);

  const getCollectionGroupKey = (item: CollectionItem) =>
    buildPromptKey(typeof item.prompt === 'string' ? item.prompt : '');

  const getCollectionKey = (item: CollectionItem, useIdOnly?: boolean) => {
    if (isUploadCollectionItem(item) && item.sourceSignature) {
      return `upload:${buildPromptKey(item.prompt)}:${item.sourceSignature}`;
    }
    return useIdOnly ? item.id : item.localKey || item.image || item.id;
  };


  const handleCollect = (item: CollectionItem) => {
    const normalized: CollectionItem = {
      ...item,
      id: item.id || item.localKey || uuidv4(),
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      taskId: typeof item.taskId === 'string' ? item.taskId : '',
    };
    const incomingKey = getCollectionKey(normalized);
    setCollectedItems((prev) => {
      if (!incomingKey) return [normalized, ...prev];
      const existingIndex = prev.findIndex(
        (entry) => getCollectionKey(entry) === incomingKey,
      );
      if (existingIndex === -1) {
        return [normalized, ...prev];
      }
      const existing = prev[existingIndex];
      const updated = { ...existing, ...normalized, id: existing.id || normalized.id };
      const next = prev.filter(
        (entry) => getCollectionKey(entry) !== incomingKey,
      );
      return [updated, ...next];
    });
  };

  const getCollectionCacheKey = (item: CollectionItem) => {
    if (item.localKey) return item.localKey;
    if (item.id && isCollectionCacheKey(item.id)) return item.id;
    return undefined;
  };

  const handleRemoveCollectedItem = (id: string) => {
    setCollectedItems((prev) => {
      const target = prev.find((item) => item.id === id);
      const cacheKey = target ? getCollectionCacheKey(target) : undefined;
      if (cacheKey) {
        void deleteImageCache(cacheKey);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleRemoveCollectedGroup = (groupKey: string) => {
    setCollectedItems((prev) => {
      const toRemove = prev.filter(
        (item) => getCollectionGroupKey(item) === groupKey,
      );
      const keys = Array.from(
        new Set(
          toRemove
            .map((item) => getCollectionCacheKey(item))
            .filter((key): key is string => typeof key === 'string'),
        ),
      );
      keys.forEach((key) => {
        void deleteImageCache(key);
      });
      return prev.filter((item) => getCollectionGroupKey(item) !== groupKey);
    });
  };

  const handleClearCollection = () => {
    const keys = Array.from(
      new Set(
        collectedItems
          .map((item) =>
            getCollectionCacheKey(item),
          )
          .filter((key): key is string => typeof key === 'string'),
      ),
    );
    keys.forEach((key) => {
      void deleteImageCache(key);
    });
    setCollectedItems([]);
  };

  const handleLog = useCallback((entry: LogEntry) => {
    setLogEntries(prev => [entry, ...prev].slice(0, 30));
  }, []);

  const updateGlobalStats = useCallback((type: 'request' | 'success' | 'fail', duration?: number) => {
    setGlobalStats((prev: GlobalStats) => {
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
  }, []);

  const handleClearGlobalStats = () => {
    setGlobalStats({ ...EMPTY_GLOBAL_STATS });
    message.success('数据总览统计已清空');
  };

  const handleDownloadAll = useCallback(async () => {
    if (downloadProgress) return;
    try {
      const pack = await buildBatchDownloadZip(tasks, collectedItems, {
        onProgress: (p) => setDownloadProgress(p),
      });
      if (!pack) {
        message.warning('暂无可下载的图片');
        return;
      }
      downloadBlob(pack.blob, buildZipFilename());
      if (pack.result.failed === 0) {
        message.success(`已下载 ${pack.result.success} 张图片`);
      } else if (pack.result.success === 0) {
        message.error(`下载失败：${pack.result.errors[0] || '未知错误'}`);
      } else {
        message.warning(`已下载 ${pack.result.success} 张，${pack.result.failed} 张失败`);
      }
    } catch (err) {
      const messageText = err instanceof Error ? err.message : '未知错误';
      message.error(`打包失败：${messageText}`);
    } finally {
      setDownloadProgress(null);
    }
  }, [tasks, collectedItems, downloadProgress]);

  const isDownloading = downloadProgress !== null;

  const successRate = calculateSuccessRate(
    globalStats.totalRequests,
    globalStats.successCount,
  );
  
  const averageTime = globalStats.successCount > 0 
    ? formatDuration(globalStats.totalTime / globalStats.successCount)
    : '0s';
  
  const fastestTimeStr = formatDuration(globalStats.fastestTime);

  const slowestTimeStr = formatDuration(globalStats.slowestTime);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#FF9EB5',
          colorTextBase: '#665555',
          colorBgBase: '#FFF9FA',
          borderRadius: 20,
          fontFamily: "'Nunito', 'Quicksand', sans-serif",
        },
        components: {
          Button: {
            colorPrimary: '#FF9EB5',
            algorithm: true,
            fontWeight: 700,
          },
          Input: {
            colorBgContainer: '#FFF0F3',
            activeBorderColor: '#FF9EB5',
            hoverBorderColor: '#FFB7C5',
          },
          Drawer: {
            colorBgElevated: '#FFFFFF',
          }
        }
      }}
    >
      <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
        {/* 顶部导航栏 */}
        <Header className="app-header" style={{ 
          height: 72, 
          // padding handled in css
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(12px)',
          borderBottom: '2px dashed #FFF0F3',
          boxShadow: '0 4px 20px rgba(255, 158, 181, 0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <div className="hover-scale" style={{ 
              width: 44, 
              height: 44, 
              background: 'linear-gradient(135deg, #FF9EB5 0%, #FF7090 100%)', 
              borderRadius: 16, 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              boxShadow: '0 6px 0 #FF7090, 0 8px 16px rgba(255, 158, 181, 0.4)',
              transform: 'rotate(-8deg)',
              border: '2px solid #fff'
            }}>
              <HeartFilled style={{ fontSize: 24, color: '#fff' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
              <Title level={3} style={{ margin: 0, color: '#665555', fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1, whiteSpace: 'nowrap' }}>
                萌图 <span style={{ color: '#FF9EB5' }}>工坊</span>
              </Title>
              <Text style={{ margin: 0, color: '#FF9EB5', fontWeight: 700, fontSize: 12, letterSpacing: '0.5px', lineHeight: 1, marginTop: 4 }}>
                moe atelier
              </Text>
            </div>
          </div>

          <Space size={8} className="header-actions">
            <Tooltip title="提示词广场">
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                className="mobile-hidden"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              >
                广场
              </Button>
            </Tooltip>
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                shape="circle"
                className="desktop-hidden circle-icon-btn"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
            />

            <Tooltip title={isDownloading ? `打包中 ${downloadProgress.current}/${downloadProgress.total}` : '下载所有图片（不含上传参考图）'}>
              <Button
                icon={isDownloading ? <LoadingOutlined spin /> : <DownloadOutlined />}
                onClick={handleDownloadAll}
                size="large"
                disabled={isDownloading}
                className="mobile-hidden"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              >
                {isDownloading
                  ? `打包中 ${downloadProgress.current}/${downloadProgress.total}`
                  : '下载所有'}
              </Button>
            </Tooltip>
            <Tooltip title="下载所有图片（不含上传参考图）">
              <Button
                icon={<DownloadOutlined />}
                onClick={handleDownloadAll}
                size="large"
                shape="circle"
                disabled={isDownloading}
                className="desktop-hidden circle-icon-btn"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              />
            </Tooltip>

            <Button 
              icon={<SettingFilled />} 
              onClick={() => setConfigVisible(true)}
              size="large"
              className="mobile-hidden"
            >
              系统配置
            </Button>
            <Button 
              icon={<SettingFilled />} 
              onClick={() => setConfigVisible(true)}
              size="large"
              shape="circle"
              className="desktop-hidden circle-icon-btn"
            />
            <Button 
              type="primary" 
              icon={<PlusOutlined />} 
              onClick={handleAddTask}
              size="large"
            >
              新建任务
            </Button>
          </Space>
        </Header>
        
        <Content style={{ padding: '24px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
          
          {/* 数据仪表盘 - 重新设计 */}
          <div className="fade-in-up" style={{ marginBottom: 32 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 16,
                paddingLeft: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AppstoreFilled style={{ fontSize: 18, color: '#FF9EB5' }} />
                <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
                  数据总览
                </Text>
              </div>
              <Button
                size="small"
                icon={<DeleteFilled />}
                onClick={handleClearGlobalStats}
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              >
                清空统计
              </Button>
            </div>
            
            <div className="stat-panel">
              <Row gutter={[16, 16]}>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#FFF0F3', color: '#FF9EB5',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #FFB7C5, 0 4px 8px rgba(255,158,181,0.2)', transform: 'rotate(-5deg)'
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value">{globalStats.totalRequests}</div>
                    <div className="stat-label">总请求数</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#E8F5E9', color: '#6BCB8A',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #A7E8BD, 0 4px 8px rgba(107,203,138,0.2)', transform: 'rotate(5deg)'
                    }}>
                      <CheckCircleFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#6BCB8A' }}>{globalStats.successCount}</div>
                    <div className="stat-label">成功生成</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#FFF8D6', color: '#FFC857',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #FFE5A0, 0 4px 8px rgba(255,200,87,0.2)', transform: 'rotate(-5deg)'
                    }}>
                      <TrophyFilled />
                    </div>
                    <div className="stat-value" style={{ color: successRate > 80 ? '#6BCB8A' : '#FFC857' }}>
                      {successRate}%
                    </div>
                    <div className="stat-label">成功率</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#E0F7FA', color: '#00BCD4',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #A0E1E8, 0 4px 8px rgba(0,188,212,0.2)', transform: 'rotate(5deg)'
                    }}>
                      <RocketFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#00BCD4' }}>{fastestTimeStr}</div>
                    <div className="stat-label">最快用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#FFF3E0', color: '#FF9800',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #FFCC80, 0 4px 8px rgba(255,152,0,0.2)', transform: 'rotate(-5deg)'
                    }}>
                      <HourglassFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#FF9800' }}>{slowestTimeStr}</div>
                    <div className="stat-label">最慢用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#F3E5F5', color: '#9C27B0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #E1BEE7, 0 4px 8px rgba(156,39,176,0.2)', transform: 'rotate(5deg)'
                    }}>
                      <DashboardFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#9C27B0' }}>{averageTime}</div>
                    <div className="stat-label">平均用时</div>
                  </div>
                </Col>
              </Row>
            </div>
          </div>

          {/* 任务列表 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, paddingLeft: 4 }}>
            <div style={{ 
              width: 24, height: 24, borderRadius: '50%', background: '#FF9EB5', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
              fontSize: 12, fontWeight: 700
            }}>
              {tasks.length}
            </div>
            <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
              进行中的任务
            </Text>
          </div>

          <TaskGrid
            tasks={tasks}
            config={config}
            collectionRevision={collectionRevision}
            onRemoveTask={handleRemoveTask}
            onStatsUpdate={updateGlobalStats}
            onCollect={handleCollect}
            onLog={handleLog}
            logEntries={logEntries}
            onReorder={handleReorderTasks}
          />
        </Content>

        <PromptDrawer 
          visible={promptDrawerVisible}
          onClose={() => setPromptDrawerVisible(false)}
          onCreateTask={handleCreateTaskFromPrompt}
        />
        
        {config.enableCollection && (
          <CollectionBox
            visible={collectionVisible}
            onClose={() => setCollectionVisible(!collectionVisible)}
            collectedItems={collectedItems}
            onRemoveItem={handleRemoveCollectedItem}
            onRemoveGroup={handleRemoveCollectedGroup}
            onClear={handleClearCollection}
            onCreateTask={handleCreateTaskFromCollection}
            privacyMode={config.privacyMode}
          />
        )}

        <ConfigDrawer
          visible={configVisible}
          config={config}
          form={form}
          onClose={() => setConfigVisible(false)}
          onConfigChange={handleConfigChange}
          models={models}
          loadingModels={loadingModels}
          fetchModels={fetchModels}
        />

        <div style={{
          textAlign: 'center',
          padding: '12px 0 24px',
          fontSize: 11,
          color: '#D0C0C0',
          userSelect: 'none',
        }}>
          构建时间：{__BUILD_TIME__}
        </div>
      </Layout>
    </ConfigProvider>
  );
}

export default App;

