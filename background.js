const DEFAULT_API_BASE_URL = 'http://lixindemac-studio.local:8127';
const MAX_CANDIDATES = 50;
const MAX_NETWORK_CANDIDATES_PER_TAB = 80;
const NETWORK_CANDIDATE_TTL_MS = 30 * 60 * 1000;
const UPLOADABLE_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm']);
const PLAYLIST_EXTENSIONS = new Set(['m3u8', 'mpd']);
const SEGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'cmfa', 'cmfv', 'm2ts']);
const BLOCKED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'woff', 'woff2', 'ttf', 'html']);
const BLOCKED_CONTENT_TYPES = ['image/', 'font/', 'text/css', 'text/html', 'application/javascript', 'text/javascript'];
const CONTENT_TYPE_EXTENSION_MAP = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

const chromeApi = typeof chrome === 'undefined' ? null : chrome;

let listeningTabId = null;
let listeningTabInfo = null;
let tabNetworkCandidates = new Map();
let globalState = {
  phase: 'idle',
  statusText: '等待开始...',
  url: null,
  candidates: [],
  transcript: '',
  summary: '',
  error: '',
};

if (chromeApi?.runtime?.onInstalled) {
  setupExtensionRuntime();
}

function setupExtensionRuntime() {
  setupWebRequestListener();
  setupTabLifecycleListeners();

  chromeApi.runtime.onInstalled.addListener(() => {
    setupContextMenu();
    if (chromeApi.sidePanel.setPanelBehavior) {
      chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
    chromeApi.storage.local.get(['apiBaseUrl'], (res) => {
      if (!res.apiBaseUrl) {
        chromeApi.storage.local.set({ apiBaseUrl: DEFAULT_API_BASE_URL });
      }
    });
  });

  chromeApi.runtime.onStartup.addListener(setupContextMenu);

  chromeApi.action.onClicked.addListener((tab) => {
    if (tab?.windowId) {
      Promise.resolve(chromeApi.sidePanel.open({ windowId: tab.windowId })).catch(() => {
        chromeApi.runtime.openOptionsPage();
      });
    } else {
      chromeApi.runtime.openOptionsPage();
    }
  });

  chromeApi.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STATE') {
      sendResponse(globalState);
      return false;
    }

    if (request.type === 'SCAN_PAGE') {
      scanActiveTab();
      return true;
    }

    if (request.type === 'PAGE_MEDIA_CANDIDATES') {
      receivePageCandidates(sender.tab, request.candidates || []);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  chromeApi.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'dayibin_scan_audio' || !tab?.id) return;
    Promise.resolve(chromeApi.sidePanel.open({ windowId: tab.windowId })).finally(() => {
      scanTab(tab);
    });
  });
}

function dispatchStateChange(updates = {}) {
  globalState = { ...globalState, ...updates };
  chromeApi.runtime.sendMessage({ type: 'STATE_UPDATE', state: globalState }).catch(() => {
    // Side panel may be closed.
  });
}

function setupContextMenu() {
  chromeApi.contextMenus.removeAll(() => {
    chromeApi.contextMenus.create({
      id: 'dayibin_scan_audio',
      title: '扫描本页录音',
      contexts: ['all'],
    });
  });
}

function setupWebRequestListener() {
  if (!chromeApi?.webRequest?.onCompleted) return;
  chromeApi.webRequest.onCompleted.addListener(
    rememberNetworkCandidate,
    { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] },
    ['responseHeaders']
  );
}

function setupTabLifecycleListeners() {
  if (!chromeApi?.tabs) return;
  chromeApi.tabs.onRemoved.addListener((tabId) => {
    tabNetworkCandidates.delete(tabId);
    if (listeningTabId === tabId) {
      listeningTabId = null;
      listeningTabInfo = null;
    }
  });
  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') return;
    tabNetworkCandidates.delete(tabId);
    if (listeningTabId === tabId) {
      listeningTabInfo = null;
      globalState = { ...globalState, candidates: [] };
    }
  });
}

function scanActiveTab() {
  chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id) {
      dispatchStateChange({
        phase: 'error',
        error: '没有找到当前网页。',
        statusText: '扫描失败',
      });
      return;
    }
    scanTab(tab);
  });
}

function scanTab(tab) {
  listeningTabId = tab.id;
  listeningTabInfo = { title: tab.title || '', url: tab.url || '' };
  dispatchStateChange({
    phase: 'extracting',
    statusText: '正在监听当前网页。请点击网页上的播放按钮，插件会自动收集候选录音。',
    url: null,
    candidates: [],
    transcript: '',
    summary: '',
    error: '',
  });

  chromeApi.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: installPageMediaObserver,
    },
    () => {
      if (chromeApi.runtime.lastError) {
        dispatchStateChange({
          phase: 'error',
          error: `无法读取当前网页：${chromeApi.runtime.lastError.message}`,
          statusText: '扫描失败',
        });
        return;
      }
      collectCandidatesFromTab(tab);
    }
  );
}

function collectCandidatesFromTab(tab) {
  chromeApi.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: collectMediaCandidates,
    },
    (results) => {
      if (chromeApi.runtime.lastError) {
        dispatchStateChange({
          phase: 'error',
          error: `无法读取当前网页：${chromeApi.runtime.lastError.message}`,
          statusText: '扫描失败',
        });
        return;
      }

      const candidates = mergeCandidates([
        ...(results?.[0]?.result || []),
        ...recentNetworkCandidates(tab.id),
      ]);
      if (candidates.length === 0) {
        dispatchStateChange({
          phase: 'extracting',
          statusText: '正在监听中。请在网页里点击播放录音，发现候选后会自动出现。',
          candidates: [],
          error: '',
        });
        return;
      }

      dispatchCandidates(candidates);
    }
  );
}

function receivePageCandidates(tab, candidates) {
  if (!tab?.id || !Array.isArray(candidates)) return;
  const normalized = candidates.map((candidate) => enrichCandidate(candidate, tab)).filter(Boolean);
  rememberTabCandidates(tab.id, normalized);
  if (tab.id === listeningTabId) {
    dispatchCandidates(mergeCandidates([...globalState.candidates, ...normalized, ...recentNetworkCandidates(tab.id)]));
  }
}

function rememberNetworkCandidate(details) {
  if (!details || details.tabId === undefined || details.tabId < 0) return;
  const contentType = headerValue(details.responseHeaders, 'content-type');
  const contentLength = Number(headerValue(details.responseHeaders, 'content-length') || 0);
  const candidate = candidateFromUrl(details.url, `network:${details.type || 'request'}`, {
    contentType,
    size: contentLength,
    pageUrl: details.initiator || '',
    foundAt: new Date().toISOString(),
  });
  if (!candidate) return;
  rememberTabCandidates(details.tabId, [candidate]);
  if (details.tabId === listeningTabId) {
    dispatchCandidates(mergeCandidates([...globalState.candidates, candidate, ...recentNetworkCandidates(details.tabId)]));
  }
}

function rememberTabCandidates(tabId, candidates) {
  if (!tabId || !candidates.length) return;
  const current = tabNetworkCandidates.get(tabId) || [];
  const merged = mergeCandidates([...current, ...candidates])
    .filter((candidate) => !isExpiredCandidate(candidate))
    .slice(0, MAX_NETWORK_CANDIDATES_PER_TAB);
  tabNetworkCandidates.set(tabId, merged);
}

function recentNetworkCandidates(tabId) {
  return (tabNetworkCandidates.get(tabId) || []).filter((candidate) => !isExpiredCandidate(candidate));
}

function isExpiredCandidate(candidate) {
  const time = Date.parse(candidate.foundAt || '');
  return Number.isFinite(time) && Date.now() - time > NETWORK_CANDIDATE_TTL_MS;
}

function dispatchCandidates(candidates) {
  const visible = mergeCandidates(candidates).slice(0, MAX_CANDIDATES);
  dispatchStateChange({
    phase: 'confirm',
    statusText: `发现 ${visible.length} 个候选录音，请确认后进入上传识别。`,
    url: visible[0]?.url || null,
    candidates: visible,
    error: '',
  });
}

function mergeCandidates(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    if (!candidate?.url) continue;
    const key = stripQuery(candidate.url);
    const previous = seen.get(key);
    if (!previous || candidateScore(candidate) > candidateScore(previous)) {
      seen.set(key, candidate);
    }
  }
  return Array.from(seen.values())
    .sort((left, right) => candidateScore(right) - candidateScore(left))
    .slice(0, MAX_CANDIDATES);
}

function candidateScore(candidate) {
  let score = Number(candidate.size || 0);
  if (candidate.uploadable) score += 10_000_000_000;
  if (candidate.source?.startsWith('network')) score += 1_000_000;
  if (candidate.contentType) score += 100_000;
  return score;
}

function stripQuery(url) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(url).split('?')[0].split('#')[0];
  }
}

function enrichCandidate(candidate, tab) {
  const normalized = candidateFromUrl(candidate.url, candidate.source || 'page', candidate);
  if (!normalized) return null;
  return {
    ...normalized,
    pageTitle: normalized.pageTitle || tab.title || listeningTabInfo?.title || '',
    pageUrl: normalized.pageUrl || tab.url || listeningTabInfo?.url || '',
  };
}

function candidateFromUrl(url, source, metadata = {}) {
  if (!url) return null;
  const stringUrl = String(url);
  if (stringUrl.startsWith('blob:')) {
    return {
      url: stringUrl,
      source,
      name: '网页临时音频',
      type: 'blob',
      size: Number(metadata.size || 0),
      contentType: metadata.contentType || '',
      pageTitle: metadata.pageTitle || '',
      pageUrl: metadata.pageUrl || '',
      foundAt: metadata.foundAt || new Date().toISOString(),
      uploadable: false,
      unsupportedReason: '这是网页临时 blob 地址，需要捕获它背后的网络音频请求。',
    };
  }
  if (!/^https?:\/\//i.test(stringUrl)) return null;

  const contentType = normalizeContentType(metadata.contentType);
  if (isBlockedContentType(contentType)) return null;

  const ext = extensionFromUrl(stringUrl);
  if (BLOCKED_EXTENSIONS.has(ext)) return null;
  if (SEGMENT_EXTENSIONS.has(ext) || contentType === 'video/mp2t') return null;

  const lowerUrl = stringUrl.toLowerCase();
  const mappedExt = CONTENT_TYPE_EXTENSION_MAP[contentType] || '';
  const type = ext || mappedExt || mediaTypeFromUrl(lowerUrl) || 'media';
  const playlist = PLAYLIST_EXTENSIONS.has(ext) || isPlaylistContentType(contentType);
  const looksLikeMedia =
    UPLOADABLE_EXTENSIONS.has(ext) ||
    Boolean(mappedExt) ||
    playlist ||
    lowerUrl.includes('/audio') ||
    lowerUrl.includes('/media') ||
    lowerUrl.includes('audio') ||
    lowerUrl.includes('record') ||
    lowerUrl.includes('voice') ||
    source === 'audio' ||
    source === 'video' ||
    source.startsWith('network:media');

  if (!looksLikeMedia) return null;

  const uploadable = !playlist;
  return {
    url: stringUrl,
    source,
    name: candidateName(stringUrl, type),
    type,
    size: Number(metadata.size || 0),
    contentType,
    pageTitle: metadata.pageTitle || '',
    pageUrl: metadata.pageUrl || '',
    foundAt: metadata.foundAt || new Date().toISOString(),
    uploadable,
    unsupportedReason: uploadable ? '' : '这是播放列表或分片流，当前不能直接上传为单个录音文件。',
  };
}

function normalizeContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function isBlockedContentType(contentType) {
  return Boolean(contentType && BLOCKED_CONTENT_TYPES.some((blocked) => contentType.startsWith(blocked)));
}

function isPlaylistContentType(contentType) {
  return [
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'audio/mpegurl',
    'audio/x-mpegurl',
    'application/dash+xml',
  ].includes(contentType);
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const last = pathname.split('/').filter(Boolean).pop() || '';
    const ext = last.includes('.') ? last.split('.').pop() : '';
    return ext.replace(/[^a-z0-9]/g, '');
  } catch {
    const path = String(url).split('?')[0].split('#')[0].toLowerCase();
    const last = path.split('/').filter(Boolean).pop() || '';
    return last.includes('.') ? last.split('.').pop().replace(/[^a-z0-9]/g, '') : '';
  }
}

function mediaTypeFromUrl(lowerUrl) {
  if (lowerUrl.includes('.mp3')) return 'mp3';
  if (lowerUrl.includes('.m4a')) return 'm4a';
  if (lowerUrl.includes('.wav')) return 'wav';
  if (lowerUrl.includes('.mp4')) return 'mp4';
  if (lowerUrl.includes('.webm')) return 'webm';
  return '';
}

function candidateName(url, type) {
  let base = '网页录音';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || base);
  } catch {
    base = String(url).split('?')[0].split('/').filter(Boolean).pop() || base;
  }
  if (!base.includes('.') && UPLOADABLE_EXTENSIONS.has(type)) return `${base}.${type}`;
  return base;
}

function headerValue(headers = [], name) {
  const header = headers.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

function collectMediaCandidates() {
  const uploadableExtensions = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm'];
  const playlistExtensions = ['m3u8', 'mpd'];
  const blockedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'woff', 'woff2', 'ttf', 'html'];
  const segmentExtensions = ['ts', 'm4s', 'cmfa', 'cmfv', 'm2ts'];
  const contentTypeExtensionMap = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  };

  function extensionFrom(url) {
    try {
      const pathname = new URL(url, location.href).pathname.toLowerCase();
      const last = pathname.split('/').filter(Boolean).pop() || '';
      return last.includes('.') ? last.split('.').pop().replace(/[^a-z0-9]/g, '') : '';
    } catch {
      return '';
    }
  }

  function contentTypeFromElement(element) {
    return String(element.type || '').split(';')[0].trim().toLowerCase();
  }

  function candidateFrom(url, source, meta = {}) {
    if (!url) return null;
    const absoluteUrl = String(url).startsWith('blob:') ? String(url) : new URL(url, location.href).toString();
    if (absoluteUrl.startsWith('blob:')) {
      return {
        url: absoluteUrl,
        source,
        name: '网页临时音频',
        type: 'blob',
        size: Number(meta.size || 0),
        contentType: meta.contentType || '',
        pageTitle: document.title,
        pageUrl: location.href,
        foundAt: new Date().toISOString(),
        uploadable: false,
        unsupportedReason: '这是网页临时 blob 地址，需要捕获它背后的网络音频请求。',
      };
    }
    if (!/^https?:\/\//i.test(absoluteUrl)) return null;
    const ext = extensionFrom(absoluteUrl);
    const contentType = String(meta.contentType || '').split(';')[0].trim().toLowerCase();
    if (blockedExtensions.includes(ext) || segmentExtensions.includes(ext) || contentType === 'video/mp2t') return null;
    const lowerUrl = absoluteUrl.toLowerCase();
    const mappedExt = contentTypeExtensionMap[contentType] || '';
    const type = ext || mappedExt || (lowerUrl.includes('.mp3') ? 'mp3' : '') || 'media';
    const playlist = playlistExtensions.includes(ext) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/dash+xml'].includes(contentType);
    const looksLikeMedia =
      uploadableExtensions.includes(ext) ||
      Boolean(mappedExt) ||
      playlist ||
      lowerUrl.includes('/audio') ||
      lowerUrl.includes('/media') ||
      lowerUrl.includes('audio') ||
      lowerUrl.includes('record') ||
      lowerUrl.includes('voice') ||
      source === 'audio' ||
      source === 'video';
    if (!looksLikeMedia) return null;
    let name = decodeURIComponent(new URL(absoluteUrl).pathname.split('/').filter(Boolean).pop() || '网页录音');
    if (!name.includes('.') && uploadableExtensions.includes(type)) name = `${name}.${type}`;
    return {
      url: absoluteUrl,
      source,
      name,
      type,
      size: Number(meta.size || 0),
      contentType,
      pageTitle: document.title,
      pageUrl: location.href,
      foundAt: new Date().toISOString(),
      uploadable: !playlist,
      unsupportedReason: playlist ? '这是播放列表或分片流，当前不能直接上传为单个录音文件。' : '',
    };
  }

  const candidates = [];
  document.querySelectorAll('audio, video').forEach((media) => {
    const candidate = candidateFrom(media.currentSrc || media.src, media.tagName.toLowerCase(), {
      contentType: contentTypeFromElement(media),
    });
    if (candidate) candidates.push(candidate);
  });

  document.querySelectorAll('audio source, video source, source[src]').forEach((source) => {
    const candidate = candidateFrom(source.src, 'source', { contentType: contentTypeFromElement(source) });
    if (candidate) candidates.push(candidate);
  });

  document.querySelectorAll('a[href], link[href], [data-src], [data-url], [data-audio-url]').forEach((node) => {
    const rawUrl = node.href || node.dataset?.src || node.dataset?.url || node.dataset?.audioUrl;
    const candidate = candidateFrom(rawUrl, 'page-link');
    if (candidate) candidates.push(candidate);
  });

  window.performance.getEntriesByType('resource').forEach((entry) => {
    const candidate = candidateFrom(entry.name, `performance:${entry.initiatorType || 'resource'}`, {
      size: entry.transferSize || entry.encodedBodySize || 0,
    });
    if (candidate) candidates.push(candidate);
  });

  return candidates;
}

function installPageMediaObserver() {
  if (window.__dayibinMediaObserverInstalled) return true;
  window.__dayibinMediaObserverInstalled = true;

  const sendCandidates = () => {
    try {
      const candidates = collectMediaCandidates();
      if (candidates.length > 0) {
        const result = chrome.runtime.sendMessage({ type: 'PAGE_MEDIA_CANDIDATES', candidates });
        if (result?.catch) result.catch(() => {});
      }
    } catch {
      // Page may block access while navigating.
    }
  };

  document.addEventListener('play', sendCandidates, true);
  document.addEventListener('loadedmetadata', sendCandidates, true);
  document.addEventListener('durationchange', sendCandidates, true);
  window.setTimeout(sendCandidates, 300);
  return true;

  function collectMediaCandidates() {
    const uploadableExtensions = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm'];
    const blockedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'woff', 'woff2', 'ttf', 'html'];
    const segmentExtensions = ['ts', 'm4s', 'cmfa', 'cmfv', 'm2ts'];
    function candidateFrom(url, source) {
      if (!url) return null;
      const absoluteUrl = String(url).startsWith('blob:') ? String(url) : new URL(url, location.href).toString();
      if (absoluteUrl.startsWith('blob:')) {
        return {
          url: absoluteUrl,
          source,
          name: '网页临时音频',
          type: 'blob',
          pageTitle: document.title,
          pageUrl: location.href,
          foundAt: new Date().toISOString(),
          uploadable: false,
          unsupportedReason: '这是网页临时 blob 地址，需要捕获它背后的网络音频请求。',
        };
      }
      if (!/^https?:\/\//i.test(absoluteUrl)) return null;
      const pathname = new URL(absoluteUrl).pathname.toLowerCase();
      const last = pathname.split('/').filter(Boolean).pop() || '';
      const ext = last.includes('.') ? last.split('.').pop().replace(/[^a-z0-9]/g, '') : '';
      if (blockedExtensions.includes(ext) || segmentExtensions.includes(ext)) return null;
      const lowerUrl = absoluteUrl.toLowerCase();
      const looksLikeMedia =
        uploadableExtensions.includes(ext) ||
        lowerUrl.includes('/audio') ||
        lowerUrl.includes('/media') ||
        lowerUrl.includes('audio') ||
        lowerUrl.includes('record') ||
        lowerUrl.includes('voice') ||
        source === 'audio' ||
        source === 'video';
      if (!looksLikeMedia) return null;
      return {
        url: absoluteUrl,
        source,
        name: decodeURIComponent(last || '网页录音'),
        type: ext || 'media',
        pageTitle: document.title,
        pageUrl: location.href,
        foundAt: new Date().toISOString(),
        uploadable: true,
        unsupportedReason: '',
      };
    }
    return Array.from(document.querySelectorAll('audio, video, audio source, video source, source[src]'))
      .map((node) => candidateFrom(node.currentSrc || node.src, node.tagName.toLowerCase()))
      .filter(Boolean);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    candidateFromUrl,
    extensionFromUrl,
    headerValue,
    mergeCandidates,
    stripQuery,
  };
}
