// options.js

document.addEventListener('DOMContentLoaded', () => {
    const saveBtn = document.getElementById('saveBtn');
    const apiBaseUrlInput = document.getElementById('apiBaseUrl');
    const statusEl = document.getElementById('status');
  
    // 载入已有配置
    chrome.storage.local.get(['apiBaseUrl'], (res) => {
      apiBaseUrlInput.value = res.apiBaseUrl || 'http://lixindemac-studio.local:8127';
    });
  
    // 点击保存
    saveBtn.addEventListener('click', () => {
      const apiBaseUrl = apiBaseUrlInput.value.trim();
  
      chrome.storage.local.set({
        apiBaseUrl: apiBaseUrl
      }, () => {
        statusEl.textContent = '后端地址已保存。';
        
        // 3秒后清空状态提示
        setTimeout(() => {
          statusEl.textContent = '';
        }, 3000);
      });
    });
  });
