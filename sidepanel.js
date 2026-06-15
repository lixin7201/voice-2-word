// sidepanel.js

document.addEventListener('DOMContentLoaded', () => {
    const statusText = document.getElementById('status-text');
    const loader = document.getElementById('loader');
    const statusContainer = document.getElementById('status-container');
    
    const summarySection = document.getElementById('summary-section');
    const summaryContent = document.getElementById('summary-content');
    
    const transcriptSection = document.getElementById('transcript-section');
    const transcriptContent = document.getElementById('transcript-content');
    const transcriptToggle = document.getElementById('transcript-toggle');
    const chevron = document.getElementById('chevron');

    const errorBox = document.getElementById('error-box');
    const errorText = document.getElementById('error-text');
    const settingsBtn = document.getElementById('settings-btn');
    const confirmBox = document.getElementById('confirm-box');
    const executeBtn = document.getElementById('execute-btn');
    const scanBtn = document.getElementById('scan-btn');

    // 触发页面扫描
    scanBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: "SCAN_PAGE" });
    });

    // 用户确认执行
    executeBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: "CONFIRM_START" });
    });

    // 打开设置界面
    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // 折叠/展开 原文字稿
    transcriptToggle.addEventListener('click', (e) => {
        // 如果点击的是复制按钮，不触发折叠
        if (e.target.closest('.copy-btn')) return;
        
        transcriptContent.classList.toggle('collapsed');
        chevron.classList.toggle('rotated');
    });

    // 复制功能
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const element = document.getElementById(targetId);
            const textToCopy = element.innerText;
            
            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalSvg = btn.innerHTML;
                btn.innerHTML = `<span style="font-size: 12px; color: #10b981; font-weight: bold;">已复制!</span>`;
                setTimeout(() => {
                    btn.innerHTML = originalSvg;
                }, 2000);
            });
        });
    });

    // 渲染状态函数
    function renderState(state) {
        // Handle Error
        if (state.phase === 'error') {
            errorBox.classList.remove('hidden');
            errorText.innerText = state.error;
            statusContainer.classList.add('error');
            return;
        } else {
            errorBox.classList.add('hidden');
            statusContainer.classList.remove('error');
        }

        // Handle Text and Buttons
        statusText.innerText = state.statusText || '';
        if (state.phase === 'done' || state.phase === 'idle' || state.phase === 'confirm') {
            loader.classList.add('hidden');
        } else {
            loader.classList.remove('hidden');
        }

        if (state.phase === 'idle') {
            scanBtn.classList.remove('hidden');
            statusText.classList.add('hidden');
        } else {
            scanBtn.classList.add('hidden');
            statusText.classList.remove('hidden');
        }

        // Handle Form visibility
        if (state.phase === 'confirm') {
            confirmBox.classList.remove('hidden');
            loader.classList.add('hidden');
        } else {
            confirmBox.classList.add('hidden');
        }

        // Handle Transcript rendering
        if (state.transcript && state.transcript.length > 0) {
            transcriptSection.classList.remove('hidden');
            transcriptContent.innerText = state.transcript;
        }

        // Handle Summary skeleton and rendering
        if (state.phase === 'summarizing') {
            summarySection.classList.remove('hidden');
            summaryContent.classList.add('text-skeleton');
            summaryContent.innerText = '大模型正在奋笔疾书中... ☕';
        } else if (state.summary && state.summary.length > 0) {
            summarySection.classList.remove('hidden');
            summaryContent.classList.remove('text-skeleton');
            summaryContent.innerText = state.summary;
        }
    }

    // 1. 初始化时，主动向 background 获取最新状态
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
        if (response) {
            renderState(response);
        }
    });

    // 2. 监听来自 background 的实时更新
    chrome.runtime.onMessage.addListener((request) => {
        if (request.type === "STATE_UPDATE" && request.state) {
            renderState(request.state);
        }
    });
});
