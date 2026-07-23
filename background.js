const DEFAULT_API_BASE_URL = 'http://lixindemac-studio.local:8127';
const MAX_CANDIDATES = 12;
const MAX_NETWORK_CANDIDATES_PER_TAB = 80;
const NETWORK_CANDIDATE_TTL_MS = 30 * 60 * 1000;
const SCAN_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const LOW_CONFIDENCE_MEDIA_BYTES = 50 * 1024;
const BINARY_RECORDING_BYTES = 128 * 1024;
const UPLOADABLE_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm']);
const PLAYLIST_EXTENSIONS = new Set(['m3u8', 'mpd']);
const SEGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'cmfa', 'cmfv', 'm2ts']);
const BLOCKED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'woff', 'woff2', 'ttf', 'html']);
const BLOCKED_CONTENT_TYPES = ['image/', 'font/', 'text/css', 'text/html', 'application/javascript', 'text/javascript'];
const BINARY_MEDIA_CONTENT_TYPES = ['application/octet-stream', 'binary/octet-stream', 'application/x-binary'];
const MEDIA_URL_HINTS = [
  '/audio',
  '/media',
  '/record',
  '/recording',
  '/voice',
  '/download',
  '/file',
  '/object',
];
const UNVERIFIED_MEDIA_REASON = '这个地址缺少可确认的音频文件信息，暂不能直接读取。请先在原网页播放录音，或下载录音后手动上传。';
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
const serviceWorkerStartedAt = new Date().toISOString();

let listeningTabId = null;
let listeningTabInfo = null;
let listeningStartedAt = 0;
let lastScanError = '';
let lastContentScriptError = '';
let lastScanAction = '';
let lastCandidateAt = '';
let lastCandidateHost = '';
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

    if (request.type === 'GET_DIAGNOSTICS') {
      chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendResponse(getDiagnostics(tabs?.[0] || null));
      });
      return true;
    }

    if (request.type === 'SCAN_PAGE') {
      scanActiveTab('scan');
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === 'RESET_AND_SCAN_PAGE') {
      resetListeningState();
      scanActiveTab('reset');
      sendResponse({ ok: true });
      return false;
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
  if (globalState.phase === 'error' || updates.error) {
    lastScanError = updates.error || globalState.error || '';
  }
  chromeApi.runtime.sendMessage({ type: 'STATE_UPDATE', state: globalState }).catch(() => {
    // Side panel may be closed.
  });
}

function getDiagnostics(activeTab = null) {
  return {
    listeningTabId,
    listeningTabUrl: listeningTabInfo?.url || '',
    listeningTabTitle: listeningTabInfo?.title || '',
    activeTabUrl: activeTab?.url || '',
    activeTabTitle: activeTab?.title || '',
    listeningStartedAt: listeningStartedAt ? new Date(listeningStartedAt).toISOString() : '',
    globalStatePhase: globalState.phase,
    statusText: globalState.statusText,
    candidatesCount: Array.isArray(globalState.candidates) ? globalState.candidates.length : 0,
    networkCandidateCountForTab: listeningTabId ? recentNetworkCandidates(listeningTabId).length : 0,
    lastCandidateAt,
    lastCandidateHost,
    lastScanError,
    lastContentScriptError,
    lastScanAction,
    serviceWorkerStartedAt,
    extensionVersion: chromeApi?.runtime?.getManifest?.().version || '',
    manifestHostPermissions: chromeApi?.runtime?.getManifest?.().host_permissions || [],
  };
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
      clearListeningSession();
    }
  });
  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') return;
    handleListeningTabLoading(tabId);
  });
}

function scanActiveTab(action = 'scan') {
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
    scanTab(tab, action);
  });
}

function scanTab(tab, action = 'scan') {
  dispatchStateChange(startListeningSession(tab, action));

  chromeApi.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: installPageMediaObserver,
    },
    () => {
      if (chromeApi.runtime.lastError) {
        lastContentScriptError = chromeApi.runtime.lastError.message || '';
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

function startListeningSession(tab, action = 'scan') {
  listeningTabId = tab.id;
  listeningTabInfo = { title: tab.title || '', url: tab.url || '' };
  listeningStartedAt = Date.now();
  lastScanAction = action;
  lastContentScriptError = '';
  tabNetworkCandidates.set(tab.id, []);
  const nextState = {
    phase: 'extracting',
    statusText: '正在监听当前网页。请点击网页上的播放按钮，插件会自动收集候选录音。',
    url: null,
    candidates: [],
    transcript: '',
    summary: '',
    error: '',
  };
  globalState = { ...globalState, ...nextState };
  return nextState;
}

function handleListeningTabLoading(tabId) {
  tabNetworkCandidates.delete(tabId);
  if (listeningTabId === tabId) {
    globalState = { ...globalState, candidates: [] };
  }
}

function collectCandidatesFromTab(tab) {
  chromeApi.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: collectMediaCandidates,
    },
    (results) => {
      if (chromeApi.runtime.lastError) {
        lastContentScriptError = chromeApi.runtime.lastError.message || '';
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
  if (expireListeningSessionIfNeeded()) return;
  const normalized = candidates.map((candidate) => enrichCandidate(candidate, tab)).filter(Boolean);
  const recordingTitle = normalized.find((candidate) => candidate.recordingTitle)?.recordingTitle;
  if (recordingTitle && tab.id === listeningTabId) {
    listeningTabInfo = { ...(listeningTabInfo || {}), recordingTitle };
  }
  rememberTabCandidates(tab.id, normalized);
  if (tab.id === listeningTabId) {
    dispatchCandidates(mergeCandidates([...globalState.candidates, ...normalized, ...recentNetworkCandidates(tab.id)]));
  }
}

function rememberNetworkCandidate(details) {
  if (!details || details.tabId === undefined || details.tabId < 0) return;
  if (expireListeningSessionIfNeeded()) return;
  const contentType = headerValue(details.responseHeaders, 'content-type');
  const contentDisposition = headerValue(details.responseHeaders, 'content-disposition');
  const responseSize = sizeFromResponseHeaders(details.responseHeaders);
  const candidate = candidateFromUrl(details.url, `network:${details.type || 'request'}`, {
    contentType,
    contentDisposition,
    size: responseSize.size,
    rangeSize: responseSize.rangeSize,
    pageTitle: listeningTabInfo?.title || '',
    pageUrl: listeningTabInfo?.url || details.initiator || '',
    recordingTitle: listeningTabInfo?.recordingTitle || '',
    foundAt: new Date().toISOString(),
  });
  if (!candidate) return;
  lastCandidateAt = candidate.foundAt || new Date().toISOString();
  lastCandidateHost = safeHost(candidate.url);
  rememberTabCandidates(details.tabId, [candidate]);
  if (details.tabId === listeningTabId) {
    dispatchCandidates(mergeCandidates([...globalState.candidates, candidate, ...recentNetworkCandidates(details.tabId)]));
  }
}

function clearListeningSession() {
  listeningTabId = null;
  listeningTabInfo = null;
  listeningStartedAt = 0;
}

function resetListeningState() {
  clearListeningSession();
  tabNetworkCandidates.clear();
  lastScanError = '';
  lastContentScriptError = '';
  lastCandidateAt = '';
  lastCandidateHost = '';
  globalState = {
    ...globalState,
    phase: 'idle',
    statusText: '已重置监听状态。',
    url: null,
    candidates: [],
    error: '',
  };
}

function expireListeningSessionIfNeeded() {
  if (!listeningTabId || !listeningStartedAt) return false;
  if (Date.now() - listeningStartedAt <= SCAN_SESSION_TIMEOUT_MS) return false;
  clearListeningSession();
  if (globalState.phase === 'extracting') {
    dispatchStateChange({
      phase: 'idle',
      statusText: '监听已暂停。如需继续，请重新点击“扫描当前网页”。',
      candidates: globalState.candidates || [],
      error: '',
    });
  }
  return true;
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
  const visible = mergeCandidates(candidates)
    .map((candidate) => ({
      ...candidate,
      recordingTitle: candidate.recordingTitle || listeningTabInfo?.recordingTitle || '',
      pageTitle: candidate.pageTitle || listeningTabInfo?.title || '',
      pageUrl: candidate.pageUrl || listeningTabInfo?.url || '',
    }))
    .slice(0, MAX_CANDIDATES);
  if (visible[0]) {
    lastCandidateAt = visible[0].foundAt || new Date().toISOString();
    lastCandidateHost = safeHost(visible[0].url);
  }
  const extraCount = Math.max(0, visible.length - 1);
  const readableCount = visible.filter((candidate) => candidate.uploadable !== false).length;
  dispatchStateChange({
    phase: 'confirm',
    statusText: readableCount === 0
      ? '发现了网页候选线索，但还没有锁定可直接读取的录音。请在原网页播放录音，或改用手动上传。'
      : extraCount
      ? `已找到当前页录音，另有 ${extraCount} 个低可信候选已折叠。`
      : '已找到当前页录音，可以开始识别。',
    url: visible[0]?.url || null,
    candidates: visible,
    error: '',
  });
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function mergeCandidates(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    if (!candidate?.url) continue;
    const key = candidateKey(candidate.url);
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
  if (candidate.lowConfidence) score -= 1_000_000;
  if (candidate.current && candidate.uploadable !== false) score += 20_000_000_000;
  if (candidate.current && candidate.uploadable === false) score += 500_000;
  if (candidate.recordingTitle) score += 250_000;
  if (candidate.source?.startsWith('network')) score += 1_000_000;
  if (candidate.contentType) score += 100_000;
  return score;
}

function sizeFromResponseHeaders(headers = []) {
  const contentLength = Number(headerValue(headers, 'content-length') || 0);
  const rangeSize = totalSizeFromContentRange(headerValue(headers, 'content-range'));
  return {
    size: Math.max(contentLength || 0, rangeSize || 0),
    contentLength: contentLength || 0,
    rangeSize: rangeSize || 0,
  };
}

function totalSizeFromContentRange(value) {
  const match = String(value || '').match(/\/(\d+)\s*$/);
  if (!match) return 0;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : 0;
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

function candidateKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isVolatileQueryParam(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return String(url).split('#')[0];
  }
}

function isVolatileQueryParam(key) {
  const normalized = String(key || '').toLowerCase();
  return (
    normalized === 'token' ||
    normalized === 'access_token' ||
    normalized === 'auth' ||
    normalized === 'authorization' ||
    normalized === 'signature' ||
    normalized === 'sig' ||
    normalized === 'expires' ||
    normalized === 'expires_at' ||
    normalized === 'expiration' ||
    normalized === 'policy' ||
    normalized === 'credential' ||
    normalized === 'date' ||
    normalized === 'security-token' ||
    normalized.startsWith('x-amz-') ||
    normalized.startsWith('x-oss-') ||
    normalized.startsWith('response-') ||
    normalized.startsWith('_')
  );
}

function enrichCandidate(candidate, tab) {
  const normalized = candidateFromUrl(candidate.url, candidate.source || 'page', candidate);
  if (!normalized) return null;
  return {
    ...normalized,
    pageTitle: normalized.pageTitle || tab.title || listeningTabInfo?.title || '',
    pageUrl: normalized.pageUrl || tab.url || listeningTabInfo?.url || '',
    recordingTitle: normalized.recordingTitle || listeningTabInfo?.recordingTitle || '',
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
      recordingTitle: metadata.recordingTitle || '',
      current: Boolean(metadata.current),
      durationSeconds: Number(metadata.durationSeconds || 0),
      currentTimeSeconds: Number(metadata.currentTimeSeconds || 0),
      foundAt: metadata.foundAt || new Date().toISOString(),
      uploadable: false,
      unsupportedReason: '这是网页临时 blob 地址，需要捕获它背后的网络音频请求。',
    };
  }
  if (!/^https?:\/\//i.test(stringUrl)) return null;

  const contentType = normalizeContentType(metadata.contentType);
  if (isBlockedContentType(contentType)) return null;

  const ext = extensionFromUrl(stringUrl);
  const dispositionName = fileNameFromContentDisposition(metadata.contentDisposition);
  const dispositionExt = extensionFromFileName(dispositionName);
  if (BLOCKED_EXTENSIONS.has(ext)) return null;
  if (SEGMENT_EXTENSIONS.has(ext) || contentType === 'video/mp2t') return null;

  const lowerUrl = stringUrl.toLowerCase();
  const mappedExt = CONTENT_TYPE_EXTENSION_MAP[contentType] || '';
  const type = ext || dispositionExt || mappedExt || mediaTypeFromUrl(lowerUrl) || 'media';
  const playlist = PLAYLIST_EXTENSIONS.has(ext) || isPlaylistContentType(contentType);
  const size = Number(metadata.size || 0);
  const hasDirectFileEvidence =
    UPLOADABLE_EXTENSIONS.has(ext) ||
    UPLOADABLE_EXTENSIONS.has(dispositionExt) ||
    Boolean(mappedExt);
  const hasPlayablePageSource =
    source === 'audio' ||
    source === 'video' ||
    source === 'source' ||
    source === 'current-player';
  const probablyBinaryRecording =
    source.startsWith('network:') &&
    BINARY_MEDIA_CONTENT_TYPES.includes(contentType) &&
    size > BINARY_RECORDING_BYTES &&
    !ext;
  const probablyNetworkMediaRecording =
    source.startsWith('network:media') &&
    size > BINARY_RECORDING_BYTES &&
    !ext;
  const hintOnly = !hasDirectFileEvidence && !probablyBinaryRecording && !probablyNetworkMediaRecording && !hasPlayablePageSource && !playlist;
  const looksLikeMedia =
    hasDirectFileEvidence ||
    playlist ||
    hasMediaUrlHint(lowerUrl) ||
    probablyBinaryRecording ||
    probablyNetworkMediaRecording ||
    hasPlayablePageSource ||
    source.startsWith('network:media');

  if (!looksLikeMedia) return null;
  if (hintOnly && size > 0 && size < LOW_CONFIDENCE_MEDIA_BYTES) return null;

  const uploadable = !playlist && !hintOnly;
  return {
    url: stringUrl,
    source,
    name: candidateName(stringUrl, type, dispositionName),
    type,
    size,
    rangeSize: Number(metadata.rangeSize || 0),
    contentType,
    pageTitle: metadata.pageTitle || '',
    pageUrl: metadata.pageUrl || '',
    recordingTitle: metadata.recordingTitle || '',
    current: Boolean(metadata.current),
    durationSeconds: Number(metadata.durationSeconds || 0),
    currentTimeSeconds: Number(metadata.currentTimeSeconds || 0),
    foundAt: metadata.foundAt || new Date().toISOString(),
    uploadable,
    lowConfidence: hintOnly,
    unsupportedReason: playlist
      ? '这是播放列表或分片流，当前不能直接上传为单个录音文件。'
      : (uploadable ? '' : UNVERIFIED_MEDIA_REASON),
  };
}

function hasMediaUrlHint(lowerUrl) {
  try {
    const parsed = new URL(lowerUrl);
    const path = parsed.pathname.toLowerCase();
    return MEDIA_URL_HINTS.some((hint) => path.includes(hint));
  } catch {
    return MEDIA_URL_HINTS.some((hint) => String(lowerUrl || '').includes(hint));
  }
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

function extensionFromFileName(fileName) {
  const last = String(fileName || '').split('/').pop() || '';
  const ext = last.includes('.') ? last.split('.').pop() : '';
  return ext.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fileNameFromContentDisposition(value) {
  const text = String(value || '');
  if (!text) return '';
  const utf8Match = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].trim().replace(/^"|"$/g, '');
    }
  }
  const plainMatch = text.match(/filename="?([^";]+)"?/i);
  return plainMatch ? plainMatch[1].trim() : '';
}

function mediaTypeFromUrl(lowerUrl) {
  if (lowerUrl.includes('.mp3')) return 'mp3';
  if (lowerUrl.includes('.m4a')) return 'm4a';
  if (lowerUrl.includes('.wav')) return 'wav';
  if (lowerUrl.includes('.mp4')) return 'mp4';
  if (lowerUrl.includes('.webm')) return 'webm';
  return '';
}

function candidateName(url, type, fallbackName = '') {
  let base = '网页录音';
  if (fallbackName) base = fallbackName;
  try {
    if (!fallbackName) base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || base);
  } catch {
    if (!fallbackName) base = String(url).split('?')[0].split('/').filter(Boolean).pop() || base;
  }
  if (!base.includes('.') && UPLOADABLE_EXTENSIONS.has(type)) return `${base}.${type}`;
  return base;
}

function headerValue(headers = [], name) {
  const header = headers.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

function collectMediaCandidates() {
  const maxCandidates = 50;
  const maxMediaNodes = 120;
  const maxHintNodes = 80;
  const maxPerformanceEntries = 600;
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
  const mediaUrlHints = ['/audio', '/media', '/record', '/recording', '/voice', '/download', '/file', '/object'];
  const lowConfidenceMediaBytes = 50 * 1024;
  const unverifiedMediaReason = '这个地址缺少可确认的音频文件信息，暂不能直接读取。请先在原网页播放录音，或下载录音后手动上传。';
  const pageRecordingTitle = detectPageRecordingTitle();
  const listenStartedAt = Number(window.__dayibinListenStartedAt || 0);

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

  function hasMediaHint(url) {
    try {
      const pathname = new URL(url, location.href).pathname.toLowerCase();
      return mediaUrlHints.some((hint) => pathname.includes(hint));
    } catch {
      return mediaUrlHints.some((hint) => String(url || '').toLowerCase().includes(hint));
    }
  }

  function isCurrentMedia(media) {
    return Boolean(
      media &&
      !media.ended &&
      (media.currentTime > 0 || (!media.paused && media.readyState > 1))
    );
  }

  function detectPageRecordingTitle() {
    const text = (document.body?.innerText || '').split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 80);
    const dated = text.find((line) => /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(line) && /\d{1,2}:\d{2}/.test(line));
    if (dated) return dated.replace(/\s+/g, ' ').slice(0, 80);
    const fileName = text.find((line) => /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)\b/i.test(line));
    if (fileName) return fileName.slice(0, 100);
    return '';
  }

  function candidateFrom(url, source, meta = {}) {
    if (!url) return null;
    let absoluteUrl = '';
    try {
      absoluteUrl = String(url).startsWith('blob:') ? String(url) : new URL(url, location.href).toString();
    } catch {
      return null;
    }
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
        recordingTitle: meta.recordingTitle || pageRecordingTitle,
        current: Boolean(meta.current),
        durationSeconds: Number(meta.durationSeconds || 0),
        currentTimeSeconds: Number(meta.currentTimeSeconds || 0),
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
    const size = Number(meta.size || 0);
    const hasDirectFileEvidence = uploadableExtensions.includes(ext) || Boolean(mappedExt);
    const hasPlayablePageSource = source === 'audio' || source === 'video' || source === 'source' || source === 'current-player';
    const hintOnly = !hasDirectFileEvidence && !hasPlayablePageSource && !playlist;
    const looksLikeMedia =
      hasDirectFileEvidence ||
      playlist ||
      hasMediaHint(absoluteUrl) ||
      hasPlayablePageSource;
    if (!looksLikeMedia) return null;
    if (hintOnly && size > 0 && size < lowConfidenceMediaBytes) return null;
    let name = decodeURIComponent(new URL(absoluteUrl).pathname.split('/').filter(Boolean).pop() || '网页录音');
    if (!name.includes('.') && uploadableExtensions.includes(type)) name = `${name}.${type}`;
    const uploadable = !playlist && !hintOnly;
    return {
      url: absoluteUrl,
      source,
      name,
      type,
      size,
      contentType,
      pageTitle: document.title,
      pageUrl: location.href,
      recordingTitle: meta.recordingTitle || pageRecordingTitle,
      current: Boolean(meta.current),
      durationSeconds: Number(meta.durationSeconds || 0),
      currentTimeSeconds: Number(meta.currentTimeSeconds || 0),
      foundAt: new Date().toISOString(),
      uploadable,
      lowConfidence: hintOnly,
      unsupportedReason: playlist ? '这是播放列表或分片流，当前不能直接上传为单个录音文件。' : (uploadable ? '' : unverifiedMediaReason),
    };
  }

  const candidates = [];
  const addCandidate = (candidate) => {
    if (candidate && candidates.length < maxCandidates) candidates.push(candidate);
  };
  const eachLimited = (selector, limit, handler) => {
    let visited = 0;
    for (const node of document.querySelectorAll(selector)) {
      if (visited >= limit || candidates.length >= maxCandidates) break;
      visited += 1;
      handler(node);
    }
  };

  eachLimited('audio, video', maxMediaNodes, (media) => {
    const current = isCurrentMedia(media);
    const candidate = candidateFrom(media.currentSrc || media.src, current ? 'current-player' : media.tagName.toLowerCase(), {
      contentType: contentTypeFromElement(media),
      current,
      durationSeconds: Number.isFinite(media.duration) ? media.duration : 0,
      currentTimeSeconds: Number.isFinite(media.currentTime) ? media.currentTime : 0,
    });
    addCandidate(candidate);
  });

  eachLimited('audio source, video source, source[src]', maxMediaNodes, (source) => {
    const candidate = candidateFrom(source.src, 'source', { contentType: contentTypeFromElement(source) });
    addCandidate(candidate);
  });

  eachLimited('[data-audio-url], [data-media-url], [data-record-url], [data-recording-url], [data-file-url], [data-src], a[download][href], a[href*="audio"], a[href*="record"], a[href*="voice"], link[type^="audio"][href], link[type^="video"][href]', maxHintNodes, (node) => {
    const rawUrl = node.href || node.dataset?.audioUrl || node.dataset?.mediaUrl || node.dataset?.recordUrl || node.dataset?.recordingUrl || node.dataset?.fileUrl || node.dataset?.src;
    addCandidate(candidateFrom(rawUrl, 'page-link'));
  });

  const performanceEntries = window.performance?.getEntriesByType
    ? window.performance.getEntriesByType('resource')
      .filter((entry) => !listenStartedAt || entry.startTime >= listenStartedAt - 1500)
      .slice(-maxPerformanceEntries)
    : [];
  performanceEntries.forEach((entry) => {
    if (candidates.length >= maxCandidates) return;
    const candidate = candidateFrom(entry.name, `performance:${entry.initiatorType || 'resource'}`, {
      size: entry.transferSize || entry.encodedBodySize || 0,
    });
    addCandidate(candidate);
  });

  return candidates;
}

function installPageMediaObserver() {
  window.__dayibinListenStartedAt = window.performance?.now ? window.performance.now() : 0;
  if (window.__dayibinMediaObserverInstalled) {
    if (typeof window.__dayibinSendMediaCandidates === 'function') {
      window.__dayibinSendMediaCandidates();
    }
    return true;
  }
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
  window.__dayibinSendMediaCandidates = sendCandidates;

  let pendingTimer = 0;
  const scheduleSend = () => {
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(sendCandidates, 250);
  };

  document.addEventListener('play', sendCandidates, true);
  document.addEventListener('playing', sendCandidates, true);
  document.addEventListener('loadedmetadata', sendCandidates, true);
  document.addEventListener('loadeddata', sendCandidates, true);
  document.addEventListener('canplay', sendCandidates, true);
  document.addEventListener('durationchange', sendCandidates, true);
  try {
    const observer = new MutationObserver(scheduleSend);
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data-audio-url', 'data-media-url', 'data-record-url'],
    });
  } catch {
    // Some pages block observers during navigation.
  }
  window.setTimeout(sendCandidates, 300);
  window.setTimeout(sendCandidates, 1200);
  return true;

  function collectMediaCandidates() {
    const maxCandidates = 50;
    const maxMediaNodes = 120;
    const maxHintNodes = 80;
    const maxPerformanceEntries = 600;
    const uploadableExtensions = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm'];
    const playlistExtensions = ['m3u8', 'mpd'];
    const blockedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'woff', 'woff2', 'ttf', 'html'];
    const segmentExtensions = ['ts', 'm4s', 'cmfa', 'cmfv', 'm2ts'];
    const mediaUrlHints = ['/audio', '/media', '/record', '/recording', '/voice', '/download', '/file', '/object'];
    const lowConfidenceMediaBytes = 50 * 1024;
    const unverifiedMediaReason = '这个地址缺少可确认的音频文件信息，暂不能直接读取。请先在原网页播放录音，或下载录音后手动上传。';
    const pageRecordingTitle = detectPageRecordingTitle();
    const listenStartedAt = Number(window.__dayibinListenStartedAt || 0);

    function hasMediaHint(url) {
      try {
        const pathname = new URL(url, location.href).pathname.toLowerCase();
        return mediaUrlHints.some((hint) => pathname.includes(hint));
      } catch {
        return mediaUrlHints.some((hint) => String(url || '').toLowerCase().includes(hint));
      }
    }

    function isCurrentMedia(media) {
      return Boolean(
        media &&
        !media.ended &&
        (media.currentTime > 0 || (!media.paused && media.readyState > 1))
      );
    }

    function detectPageRecordingTitle() {
      const text = (document.body?.innerText || '').split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 80);
      const dated = text.find((line) => /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(line) && /\d{1,2}:\d{2}/.test(line));
      if (dated) return dated.replace(/\s+/g, ' ').slice(0, 80);
      const fileName = text.find((line) => /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)\b/i.test(line));
      if (fileName) return fileName.slice(0, 100);
      return '';
    }

    function candidateFrom(url, source, meta = {}) {
      if (!url) return null;
      let absoluteUrl = '';
      try {
        absoluteUrl = String(url).startsWith('blob:') ? String(url) : new URL(url, location.href).toString();
      } catch {
        return null;
      }
      if (absoluteUrl.startsWith('blob:')) {
        return {
          url: absoluteUrl,
          source,
          name: '网页临时音频',
          type: 'blob',
          size: Number(meta.size || 0),
          pageTitle: document.title,
          pageUrl: location.href,
          recordingTitle: meta.recordingTitle || pageRecordingTitle,
          current: Boolean(meta.current),
          durationSeconds: Number(meta.durationSeconds || 0),
          currentTimeSeconds: Number(meta.currentTimeSeconds || 0),
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
      const contentType = String(meta.contentType || '').split(';')[0].trim().toLowerCase();
      const playlist = playlistExtensions.includes(ext) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/dash+xml'].includes(contentType);
      const size = Number(meta.size || 0);
      const hasDirectFileEvidence = uploadableExtensions.includes(ext);
      const hasPlayablePageSource = source === 'audio' || source === 'video' || source === 'source' || source === 'current-player';
      const hintOnly = !hasDirectFileEvidence && !hasPlayablePageSource && !playlist;
      const looksLikeMedia =
        hasDirectFileEvidence ||
        playlist ||
        hasMediaHint(absoluteUrl) ||
        hasPlayablePageSource;
      if (!looksLikeMedia) return null;
      if (hintOnly && size > 0 && size < lowConfidenceMediaBytes) return null;
      const uploadable = !playlist && !hintOnly;
      return {
        url: absoluteUrl,
        source,
        name: decodeURIComponent(last || '网页录音'),
        type: ext || 'media',
        size,
        contentType,
        pageTitle: document.title,
        pageUrl: location.href,
        recordingTitle: meta.recordingTitle || pageRecordingTitle,
        current: Boolean(meta.current),
        durationSeconds: Number(meta.durationSeconds || 0),
        currentTimeSeconds: Number(meta.currentTimeSeconds || 0),
        foundAt: new Date().toISOString(),
        uploadable,
        lowConfidence: hintOnly,
        unsupportedReason: playlist ? '这是播放列表或分片流，当前不能直接上传为单个录音文件。' : (uploadable ? '' : unverifiedMediaReason),
      };
    }
    const candidates = [];
    const addCandidate = (candidate) => {
      if (candidate && candidates.length < maxCandidates) candidates.push(candidate);
    };
    const eachLimited = (selector, limit, handler) => {
      let visited = 0;
      for (const node of document.querySelectorAll(selector)) {
        if (visited >= limit || candidates.length >= maxCandidates) break;
        visited += 1;
        handler(node);
      }
    };
    eachLimited('audio, video, audio source, video source, source[src]', maxMediaNodes, (node) => {
      const tagName = node.tagName.toLowerCase();
      const current = tagName === 'audio' || tagName === 'video' ? isCurrentMedia(node) : false;
      addCandidate(candidateFrom(node.currentSrc || node.src, current ? 'current-player' : tagName, {
        contentType: node.type || '',
        current,
        durationSeconds: Number.isFinite(node.duration) ? node.duration : 0,
        currentTimeSeconds: Number.isFinite(node.currentTime) ? node.currentTime : 0,
      }));
    });
    eachLimited('[data-audio-url], [data-media-url], [data-record-url], [data-recording-url], [data-file-url], [data-src], a[download][href], a[href*="audio"], a[href*="record"], a[href*="voice"]', maxHintNodes, (node) => {
      addCandidate(candidateFrom(node.href || node.dataset?.audioUrl || node.dataset?.mediaUrl || node.dataset?.recordUrl || node.dataset?.recordingUrl || node.dataset?.fileUrl || node.dataset?.src, 'page-link'));
    });
    const performanceEntries = window.performance?.getEntriesByType
      ? window.performance.getEntriesByType('resource')
        .filter((entry) => !listenStartedAt || entry.startTime >= listenStartedAt - 1500)
        .slice(-maxPerformanceEntries)
      : [];
    performanceEntries.forEach((entry) => {
      addCandidate(candidateFrom(entry.name, `performance:${entry.initiatorType || 'resource'}`, {
        size: entry.transferSize || entry.encodedBodySize || 0,
      }));
    });
    return candidates;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    candidateKey,
    candidateFromUrl,
    extensionFromUrl,
    getDiagnostics,
    headerValue,
    isVolatileQueryParam,
    mergeCandidates,
    resetListeningState,
    handleListeningTabLoading,
    sizeFromResponseHeaders,
    startListeningSession,
    stripQuery,
    totalSizeFromContentRange,
  };
}
