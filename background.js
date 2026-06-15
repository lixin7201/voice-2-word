const DEFAULT_API_BASE_URL = 'http://lixindemac-studio.local:8127';

let globalState = {
  phase: 'idle',
  statusText: '等待开始...',
  url: null,
  candidates: [],
  transcript: '',
  summary: '',
  error: ''
};

function dispatchStateChange(updates = {}) {
  globalState = { ...globalState, ...updates };
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: globalState }).catch(() => {
    // Side panel may be closed.
  });
}

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'dayibin_scan_audio',
      title: '扫描本页录音',
      contexts: ['all']
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
  if (chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  chrome.storage.local.get(['apiBaseUrl'], (res) => {
    if (!res.apiBaseUrl) {
      chrome.storage.local.set({ apiBaseUrl: DEFAULT_API_BASE_URL });
    }
  });
});

chrome.runtime.onStartup.addListener(setupContextMenu);

chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId) {
    Promise.resolve(chrome.sidePanel.open({ windowId: tab.windowId })).catch(() => {
      chrome.runtime.openOptionsPage();
    });
  } else {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_STATE') {
    sendResponse(globalState);
    return false;
  }

  if (request.type === 'SCAN_PAGE') {
    scanActiveTab();
    return true;
  }

  if (request.type === 'CONFIRM_START') {
    dispatchStateChange({
      phase: 'error',
      error: '已找到录音候选。新版上传和后端任务系统会在下一阶段接入。',
      statusText: '等待后端任务系统接入'
    });
    return false;
  }

  return false;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'dayibin_scan_audio' || !tab?.id) return;
  Promise.resolve(chrome.sidePanel.open({ windowId: tab.windowId })).finally(() => {
    scanTab(tab);
  });
});

function scanActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id) {
      dispatchStateChange({
        phase: 'error',
        error: '没有找到当前网页。',
        statusText: '扫描失败'
      });
      return;
    }
    scanTab(tab);
  });
}

function scanTab(tab) {
  dispatchStateChange({
    phase: 'extracting',
    statusText: '正在扫描当前网页里的录音候选...',
    url: null,
    candidates: [],
    transcript: '',
    summary: '',
    error: ''
  });

  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: collectMediaCandidates
    },
    (results) => {
      if (chrome.runtime.lastError) {
        dispatchStateChange({
          phase: 'error',
          error: `无法读取当前网页：${chrome.runtime.lastError.message}`,
          statusText: '扫描失败'
        });
        return;
      }

      const candidates = dedupeCandidates(results?.[0]?.result || []);
      if (candidates.length === 0) {
        dispatchStateChange({
          phase: 'error',
          error: '没有发现可用录音。请先在网页里点击播放，再回到插件重新扫描。',
          statusText: '未发现录音'
        });
        return;
      }

      dispatchStateChange({
        phase: 'confirm',
        statusText: `发现 ${candidates.length} 个候选录音，请确认后进入上传识别。`,
        url: candidates[0].url,
        candidates
      });
    }
  );
}

function dedupeCandidates(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    if (!candidate?.url) continue;
    const key = stripQuery(candidate.url);
    const previous = seen.get(key);
    if (!previous || (candidate.size || 0) > (previous.size || 0)) {
      seen.set(key, candidate);
    }
  }
  return Array.from(seen.values()).slice(0, 20);
}

function stripQuery(url) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split('?')[0].split('#')[0];
  }
}

function collectMediaCandidates() {
  const allowedExtensions = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm'];
  const blockedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'woff', 'woff2', 'ttf'];

  function candidateFromUrl(url, source, size = 0) {
    if (!url || !/^https?:\/\//i.test(url) || url.startsWith('blob:')) return null;

    const cleanUrl = url.split('#')[0];
    const path = cleanUrl.split('?')[0].toLowerCase();
    const ext = path.includes('.') ? path.split('.').pop() : '';
    const lowerUrl = cleanUrl.toLowerCase();
    const looksLikeMedia =
      allowedExtensions.includes(ext) ||
      lowerUrl.includes('/audio') ||
      lowerUrl.includes('/media') ||
      lowerUrl.includes('audio') ||
      lowerUrl.includes('record');

    if (!looksLikeMedia || blockedExtensions.includes(ext)) return null;

    return {
      url,
      source,
      name: decodeURIComponent(path.split('/').pop() || '网页录音'),
      type: ext || 'media',
      size,
      pageTitle: document.title,
      pageUrl: location.href,
      foundAt: new Date().toISOString()
    };
  }

  const candidates = [];

  document.querySelectorAll('audio, video').forEach((media) => {
    const url = media.currentSrc || media.src;
    const candidate = candidateFromUrl(url, media.tagName.toLowerCase());
    if (candidate) candidates.push(candidate);
  });

  document.querySelectorAll('audio source, video source').forEach((source) => {
    const candidate = candidateFromUrl(source.src, 'source');
    if (candidate) candidates.push(candidate);
  });

  window.performance.getEntriesByType('resource').forEach((entry) => {
    const candidate = candidateFromUrl(entry.name, 'network', entry.transferSize || entry.encodedBodySize || 0);
    if (candidate) candidates.push(candidate);
  });

  return candidates;
}
