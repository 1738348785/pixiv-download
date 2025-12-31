// ==UserScript==
// @name         Pixiv 漫画图片批量下载器
// @namespace    http://tampermonkey.net/
// @version      1.0.6
// @description  一键下载 Pixiv 作品的所有图片并打包为 ZIP（纯原生实现，无外部依赖）
// @author       1738348785
// @match        https://www.pixiv.net/artworks/*
// @match        https://www.pixiv.net/*/artworks/*
// @icon         https://www.pixiv.net/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://github.com/1738348785/pixiv-download/raw/refs/heads/main/pixiv_downloader.user.js
// @downloadURL  https://github.com/1738348785/pixiv-download/raw/refs/heads/main/pixiv_downloader.user.js
// @connect      i.pximg.net
// @connect      pixiv.net
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============ 状态管理 ============
    let isPaused = false;
    let isDownloading = false;
    let isCancelled = false;
    let currentIllustId = null;

    // ============ JavaScript ZIP============

    class SimpleZip {
        constructor() {
            this.files = [];
        }

        addFile(name, data) {
            let uint8Data;
            if (data instanceof ArrayBuffer) {
                uint8Data = new Uint8Array(data);
            } else if (data instanceof Uint8Array) {
                uint8Data = data;
            } else if (typeof data === 'string') {
                uint8Data = new TextEncoder().encode(data);
            } else {
                throw new Error('不支持的数据类型');
            }

            this.files.push({
                name: new TextEncoder().encode(name),
                nameStr: name,
                data: uint8Data,
                crc: this.crc32(uint8Data)
            });
        }

        crc32(data) {
            let crc = 0xFFFFFFFF;
            const table = SimpleZip.getCRC32Table();
            for (let i = 0; i < data.length; i++) {
                crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
            }
            return (crc ^ 0xFFFFFFFF) >>> 0;
        }

        static getCRC32Table() {
            if (!SimpleZip._crc32Table) {
                SimpleZip._crc32Table = new Uint32Array(256);
                for (let i = 0; i < 256; i++) {
                    let c = i;
                    for (let j = 0; j < 8; j++) {
                        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    }
                    SimpleZip._crc32Table[i] = c;
                }
            }
            return SimpleZip._crc32Table;
        }

        writeLE(arr, offset, value, bytes) {
            for (let i = 0; i < bytes; i++) {
                arr[offset + i] = (value >> (8 * i)) & 0xFF;
            }
        }

        generate() {
            const now = new Date();
            const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
            const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

            let totalSize = 0;
            const fileHeaders = [];
            let offset = 0;

            for (const file of this.files) {
                const localHeaderSize = 30 + file.name.length;
                fileHeaders.push({ offset, size: localHeaderSize + file.data.length });
                totalSize += localHeaderSize + file.data.length;
                offset += localHeaderSize + file.data.length;
            }

            let centralDirSize = 0;
            for (const file of this.files) {
                centralDirSize += 46 + file.name.length;
            }

            totalSize += centralDirSize + 22;

            const output = new Uint8Array(totalSize);
            let pos = 0;

            for (let i = 0; i < this.files.length; i++) {
                const file = this.files[i];

                this.writeLE(output, pos, 0x04034B50, 4); pos += 4;
                this.writeLE(output, pos, 20, 2); pos += 2;
                this.writeLE(output, pos, 0x0800, 2); pos += 2;
                this.writeLE(output, pos, 0, 2); pos += 2;
                this.writeLE(output, pos, dosTime, 2); pos += 2;
                this.writeLE(output, pos, dosDate, 2); pos += 2;
                this.writeLE(output, pos, file.crc, 4); pos += 4;
                this.writeLE(output, pos, file.data.length, 4); pos += 4;
                this.writeLE(output, pos, file.data.length, 4); pos += 4;
                this.writeLE(output, pos, file.name.length, 2); pos += 2;
                this.writeLE(output, pos, 0, 2); pos += 2;
                output.set(file.name, pos); pos += file.name.length;
                output.set(file.data, pos); pos += file.data.length;
            }

            const centralDirOffset = pos;

            for (let i = 0; i < this.files.length; i++) {
                const file = this.files[i];

                this.writeLE(output, pos, 0x02014B50, 4); pos += 4;
                this.writeLE(output, pos, 20, 2); pos += 2;
                this.writeLE(output, pos, 20, 2); pos += 2;
                this.writeLE(output, pos, 0x0800, 2); pos += 2;
                this.writeLE(output, pos, 0, 2); pos += 2;
                this.writeLE(output, pos, dosTime, 2); pos += 2;
                this.writeLE(output, pos, dosDate, 2); pos += 2;
                this.writeLE(output, pos, file.crc, 4); pos += 4;
                this.writeLE(output, pos, file.data.length, 4); pos += 4;
                this.writeLE(output, pos, file.data.length, 4); pos += 4;
                this.writeLE(output, pos, file.name.length, 2); pos += 2;
                this.writeLE(output, pos, 0, 2); pos += 2;
                this.writeLE(output, pos, 0, 2); pos += 2;
                this.writeLE(output, pos, 0, 2); pos += 2;
                this.writeLE(output, pos, 0, 2); pos += 2;
                this.writeLE(output, pos, 0, 4); pos += 4;
                this.writeLE(output, pos, fileHeaders[i].offset, 4); pos += 4;
                output.set(file.name, pos); pos += file.name.length;
            }

            this.writeLE(output, pos, 0x06054B50, 4); pos += 4;
            this.writeLE(output, pos, 0, 2); pos += 2;
            this.writeLE(output, pos, 0, 2); pos += 2;
            this.writeLE(output, pos, this.files.length, 2); pos += 2;
            this.writeLE(output, pos, this.files.length, 2); pos += 2;
            this.writeLE(output, pos, centralDirSize, 4); pos += 4;
            this.writeLE(output, pos, centralDirOffset, 4); pos += 4;
            this.writeLE(output, pos, 0, 2); pos += 2;

            return new Blob([output], { type: 'application/zip' });
        }
    }

    // ============ 样式 ============
    const STYLES = `
        .pixiv-dl-float {
            position: fixed;
            z-index: 999999;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            user-select: none;
            transition: opacity 0.3s ease;
        }
        .pixiv-dl-float:hover {
            opacity: 1 !important;
        }
        .pixiv-dl-btn-group {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .pixiv-dl-btn-inner {
            position: relative;
        }
        .pixiv-dl-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            background: linear-gradient(135deg, #ff6b9d 0%, #c44bff 50%, #6b7cff 100%);
            color: white;
            border: none;
            border-radius: 16px;
            padding: 14px 28px;
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            box-shadow: 
                0 4px 24px rgba(196, 75, 255, 0.4),
                0 0 0 1px rgba(255,255,255,0.1) inset;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            white-space: nowrap;
            backdrop-filter: blur(10px);
            text-shadow: 0 1px 2px rgba(0,0,0,0.2);
            letter-spacing: 0.5px;
        }
        .pixiv-dl-btn:hover:not(:disabled) {
            transform: translateY(-3px) scale(1.02);
            box-shadow: 
                0 8px 32px rgba(196, 75, 255, 0.5),
                0 0 0 1px rgba(255,255,255,0.2) inset;
        }
        .pixiv-dl-btn:active:not(:disabled) {
            transform: translateY(-1px) scale(0.98);
        }
        .pixiv-dl-btn:disabled {
            background: linear-gradient(135deg, #555 0%, #333 100%);
            cursor: not-allowed;
            box-shadow: 0 2px 12px rgba(0,0,0,0.3);
        }
        .pixiv-dl-btn svg {
            width: 20px;
            height: 20px;
            flex-shrink: 0;
            filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2));
        }
        .pixiv-dl-btn .spinner {
            animation: pixiv-dl-spin 0.8s linear infinite;
        }
        @keyframes pixiv-dl-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .pixiv-dl-btn.downloading {
            background: linear-gradient(135deg, #0096ff 0%, #00c8ff 50%, #64dcff 100%);
            box-shadow: 0 4px 24px rgba(0, 150, 255, 0.4);
        }
        .pixiv-dl-btn.success {
            background: linear-gradient(135deg, #00c853 0%, #00e676 100%);
            box-shadow: 0 4px 24px rgba(0, 200, 83, 0.4);
        }
        .pixiv-dl-pause-btn {
            display: none;
            align-items: center;
            justify-content: center;
            width: 48px;
            height: 48px;
            background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%);
            color: white;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(255, 152, 0, 0.4);
            transition: all 0.3s ease;
        }
        .pixiv-dl-pause-btn:hover {
            transform: scale(1.1);
            box-shadow: 0 6px 24px rgba(255, 152, 0, 0.5);
        }
        .pixiv-dl-pause-btn.active {
            display: flex;
        }
        .pixiv-dl-pause-btn.paused {
            background: linear-gradient(135deg, #4caf50 0%, #43a047 100%);
            box-shadow: 0 4px 16px rgba(76, 175, 80, 0.4);
        }
        .pixiv-dl-pause-btn svg {
            width: 24px;
            height: 24px;
        }
        .pixiv-dl-drag-handle {
            width: 50px;
            height: 8px;
            background: linear-gradient(90deg, 
                rgba(255,107,157,0.6) 0%, 
                rgba(196,75,255,0.6) 50%, 
                rgba(107,124,255,0.6) 100%);
            border-radius: 4px;
            cursor: grab;
            transition: all 0.2s;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            position: relative;
            z-index: 10;
        }
        .pixiv-dl-drag-handle:hover {
            transform: scaleX(1.2);
            background: linear-gradient(90deg, 
                rgba(255,107,157,0.9) 0%, 
                rgba(196,75,255,0.9) 50%, 
                rgba(107,124,255,0.9) 100%);
        }
        .pixiv-dl-drag-handle:active {
            cursor: grabbing;
            transform: scaleX(1.3);
        }
        .pixiv-dl-drag-handle.downloading {
            background: linear-gradient(90deg, 
                rgba(0,150,255,0.8) 0%, 
                rgba(0,200,255,0.8) 50%, 
                rgba(100,220,255,0.8) 100%);
            animation: pixiv-dl-pulse 1.5s ease-in-out infinite;
        }
        .pixiv-dl-drag-handle.success {
            background: linear-gradient(90deg, 
                rgba(0,200,83,0.9) 0%, 
                rgba(0,230,118,0.9) 50%, 
                rgba(105,240,174,0.9) 100%);
        }
        @keyframes pixiv-dl-pulse {
            0%, 100% { opacity: 0.8; }
            50% { opacity: 1; }
        }
        .pixiv-dl-progress {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            width: 100%;
            height: 4px;
            background: rgba(255,255,255,0.2);
            border-radius: 0 0 16px 16px;
            overflow: hidden;
            opacity: 0;
            transition: opacity 0.3s;
        }
        .pixiv-dl-progress.active {
            opacity: 1;
        }
        .pixiv-dl-progress-bar {
            height: 100%;
            background: linear-gradient(90deg, #00ff88, #00ddff);
            border-radius: 2px;
            transition: width 0.3s ease;
            box-shadow: 0 0 8px rgba(0,255,136,0.5);
        }
        .pixiv-dl-btn-container {
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .pixiv-dl-btn-container .pixiv-dl-drag-handle {
            margin-top: 6px;
        }
        .pixiv-dl-count {
            position: absolute;
            top: -28px;
            left: 50%;
            transform: translateX(-50%);
            background: linear-gradient(135deg, rgba(0,150,255,0.9) 0%, rgba(0,200,255,0.9) 100%);
            color: white;
            padding: 6px 14px;
            border-radius: 14px;
            font-size: 13px;
            font-weight: 600;
            opacity: 0;
            transition: all 0.3s;
            white-space: nowrap;
            backdrop-filter: blur(4px);
            max-width: 300px;
            text-overflow: ellipsis;
            overflow: hidden;
            pointer-events: none;
            box-shadow: 0 2px 12px rgba(0, 150, 255, 0.3);
        }
        .pixiv-dl-count.active {
            opacity: 1;
        }
        .pixiv-dl-count.success {
            background: linear-gradient(135deg, rgba(0,200,83,0.9) 0%, rgba(0,230,118,0.9) 100%);
            box-shadow: 0 2px 12px rgba(0, 200, 83, 0.3);
        }
        .pixiv-dl-count.error {
            background: linear-gradient(135deg, rgba(244,67,54,0.9) 0%, rgba(255,82,82,0.9) 100%);
            box-shadow: 0 2px 12px rgba(244, 67, 54, 0.3);
        }
    `;

    // SVG 图标
    const ICONS = {
        download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        spinner: `<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`,
        check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        zip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
        pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
        play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
    };

    // ============ 工具函数 ============

    function getIllustId() {
        const match = location.pathname.match(/artworks\/(\d+)/);
        return match ? match[1] : null;
    }

    async function getIllustInfo(illustId) {
        const response = await fetch(`https://www.pixiv.net/ajax/illust/${illustId}/pages?lang=zh`);
        const data = await response.json();
        if (data.error) throw new Error(data.message);
        return data.body;
    }

    // 无超时限制的下载函数
    function downloadImage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                headers: { 'Referer': 'https://www.pixiv.net/' },
                onload: (response) => {
                    if (response.status === 200 && response.response.byteLength > 0) {
                        resolve(response.response);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: () => reject(new Error('网络错误'))
            });
        });
    }

    function saveFile(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // 等待暂停恢复
    function waitForResume() {
        return new Promise(resolve => {
            const check = () => {
                if (!isPaused) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }

    // ============ 拖拽功能 ============

    function makeDraggable(container, handle) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        const savedPos = GM_getValue('floatBtnPosition', null);
        if (savedPos) {
            container.style.left = savedPos.left + 'px';
            container.style.top = savedPos.top + 'px';
            container.style.right = 'auto';
            container.style.bottom = 'auto';
        } else {
            container.style.right = '30px';
            container.style.bottom = '120px';
        }

        handle.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = container.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            container.style.right = 'auto';
            container.style.bottom = 'auto';
            container.style.left = startLeft + 'px';
            container.style.top = startTop + 'px';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            let newLeft = startLeft + dx;
            let newTop = startTop + dy;

            newLeft = Math.max(0, Math.min(window.innerWidth - container.offsetWidth, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - container.offsetHeight, newTop));

            container.style.left = newLeft + 'px';
            container.style.top = newTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                GM_setValue('floatBtnPosition', {
                    left: parseInt(container.style.left),
                    top: parseInt(container.style.top)
                });
            }
        });
    }

    // ============ 主逻辑 ============

    async function startDownload(btn, pauseBtn, progressBar, progressContainer, countEl, handle) {
        const illustId = getIllustId();
        if (!illustId) {
            alert('无法获取作品 ID，请确保在作品页面');
            return;
        }

        if (isDownloading) return;
        isDownloading = true;
        isPaused = false;
        isCancelled = false;  // 重置取消状态

        btn.disabled = true;
        btn.classList.add('downloading');
        pauseBtn.classList.add('active');
        progressContainer.classList.add('active');
        countEl.classList.add('active');
        countEl.classList.remove('error');
        handle.classList.add('downloading');
        handle.classList.remove('success');

        const updateBtn = (icon, text) => {
            btn.innerHTML = `${icon}<span>${text}</span>`;
        };

        const updateProgress = (current, total) => {
            const percent = (current / total) * 100;
            progressBar.style.width = percent + '%';
            countEl.textContent = `${current} / ${total}`;
        };

        const updatePauseBtn = () => {
            pauseBtn.innerHTML = isPaused ? ICONS.play : ICONS.pause;
            pauseBtn.classList.toggle('paused', isPaused);
        };

        try {
            updateBtn(ICONS.spinner, '获取信息...');
            countEl.textContent = '读取中...';

            const pages = await getIllustInfo(illustId);

            if (!pages || pages.length === 0) {
                throw new Error('未找到图片');
            }

            const zip = new SimpleZip();
            const total = pages.length;
            let downloaded = 0;
            const failedList = []; // 记录失败的图片序号

            for (let i = 0; i < pages.length; i++) {
                // 检查取消状态
                if (isCancelled) {
                    throw new Error('下载已取消');
                }

                // 检查暂停状态
                if (isPaused) {
                    updateBtn(ICONS.pause, '已暂停');
                    await waitForResume();
                    // 暂停恢复后再次检查取消状态
                    if (isCancelled) {
                        throw new Error('下载已取消');
                    }
                }

                const url = pages[i].urls.original;
                const filename = url.split('/').pop();

                updateBtn(ICONS.spinner, `下载中`);
                updateProgress(i + 1, total);

                try {
                    const data = await downloadImage(url);
                    zip.addFile(filename, data);
                    downloaded++;
                } catch (e) {
                    console.error(`下载失败: ${filename}`, e);
                    failedList.push(i + 1); // 记录第几张失败
                }
            }

            if (zip.files.length === 0) {
                throw new Error('没有成功下载任何图片');
            }

            updateBtn(ICONS.zip, '打包中...');
            countEl.textContent = '压缩中...';
            await new Promise(r => setTimeout(r, 100));

            const blob = zip.generate();
            saveFile(blob, `pixiv_${illustId}.zip`);

            btn.classList.add('success');
            btn.classList.remove('downloading');
            handle.classList.remove('downloading');
            handle.classList.add('success');
            updateBtn(ICONS.check, '完成!');

            // 显示结果
            if (failedList.length > 0) {
                countEl.classList.add('error');
                if (failedList.length <= 3) {
                    countEl.textContent = `第 ${failedList.join(', ')} 张下载失败`;
                } else {
                    countEl.textContent = `${failedList.length} 张下载失败`;
                }
            } else {
                countEl.classList.add('success');
                countEl.textContent = `成功下载 ${downloaded} 张`;
            }

            setTimeout(() => {
                btn.disabled = false;
                pauseBtn.classList.remove('active');
                progressContainer.classList.remove('active');
                isDownloading = false;
            }, 3000);

        } catch (err) {
            console.error('Pixiv Downloader Error:', err);
            // 如果是用户取消的，不显示错误提示
            if (!isCancelled) {
                alert(`下载失败: ${err.message}`);
            }
            btn.disabled = false;
            btn.classList.remove('downloading');
            pauseBtn.classList.remove('active');
            progressContainer.classList.remove('active');
            countEl.classList.remove('active', 'error');
            progressBar.style.width = '0%';
            handle.classList.remove('downloading', 'success');
            updateBtn(ICONS.download, '重试');
            isDownloading = false;
        }
    }

    // 创建悬浮按钮
    function createFloatButton() {
        if (document.querySelector('.pixiv-dl-float')) return;

        const container = document.createElement('div');
        container.className = 'pixiv-dl-float';

        const handle = document.createElement('div');
        handle.className = 'pixiv-dl-drag-handle';
        handle.title = '拖动调整位置';

        const btnGroup = document.createElement('div');
        btnGroup.className = 'pixiv-dl-btn-group';

        // 创建下载按钮容器（包含按钮、进度条、拖动条和计数器）
        const btnContainer = document.createElement('div');
        btnContainer.className = 'pixiv-dl-btn-container';

        // 创建按钮内部容器（用于限制进度条宽度）
        const btnInner = document.createElement('div');
        btnInner.className = 'pixiv-dl-btn-inner';

        const btn = document.createElement('button');
        btn.className = 'pixiv-dl-btn';
        btn.innerHTML = `${ICONS.download}<span>下载 ZIP</span>`;

        const progressContainer = document.createElement('div');
        progressContainer.className = 'pixiv-dl-progress';

        const progressBar = document.createElement('div');
        progressBar.className = 'pixiv-dl-progress-bar';
        progressBar.style.width = '0%';

        const countEl = document.createElement('div');
        countEl.className = 'pixiv-dl-count';

        progressContainer.appendChild(progressBar);
        btnInner.appendChild(btn);
        btnInner.appendChild(progressContainer);
        btnInner.appendChild(countEl);
        btnContainer.appendChild(btnInner);
        btnContainer.appendChild(handle);

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'pixiv-dl-pause-btn';
        pauseBtn.innerHTML = ICONS.pause;
        pauseBtn.title = '暂停/继续';
        pauseBtn.addEventListener('click', () => {
            isPaused = !isPaused;
            pauseBtn.innerHTML = isPaused ? ICONS.play : ICONS.pause;
            pauseBtn.classList.toggle('paused', isPaused);
        });

        btnGroup.appendChild(btnContainer);
        btnGroup.appendChild(pauseBtn);

        btn.addEventListener('click', () => startDownload(btn, pauseBtn, progressBar, progressContainer, countEl, handle));

        container.appendChild(btnGroup);
        document.body.appendChild(container);

        makeDraggable(container, handle);

        // 鼠标离开时稍微透明
        let hideTimeout;
        container.addEventListener('mouseenter', () => {
            clearTimeout(hideTimeout);
            container.style.opacity = '1';
        });
        container.addEventListener('mouseleave', () => {
            if (!isDownloading) {
                hideTimeout = setTimeout(() => {
                    container.style.opacity = '0.7';
                }, 2000);
            }
        });

        console.log('Pixiv Downloader V1.0: 悬浮按钮已创建');
    }

    // 初始化
    function init() {
        const styleEl = document.createElement('style');
        styleEl.textContent = STYLES;
        document.head.appendChild(styleEl);

        createFloatButton();

        let lastUrl = location.href;

        // 重置按钮状态的函数
        function resetButtonState() {
            const btn = document.querySelector('.pixiv-dl-btn');
            const progressContainer = document.querySelector('.pixiv-dl-progress');
            const progressBar = document.querySelector('.pixiv-dl-progress-bar');
            const countEl = document.querySelector('.pixiv-dl-count');
            const handle = document.querySelector('.pixiv-dl-drag-handle');
            const pauseBtn = document.querySelector('.pixiv-dl-pause-btn');

            if (btn) {
                btn.disabled = false;
                btn.classList.remove('downloading', 'success');
                btn.innerHTML = `${ICONS.download}<span>下载 ZIP</span>`;
            }
            if (progressContainer) progressContainer.classList.remove('active');
            if (progressBar) progressBar.style.width = '0%';
            if (countEl) countEl.classList.remove('active', 'success', 'error');
            if (handle) handle.classList.remove('downloading', 'success');
            if (pauseBtn) pauseBtn.classList.remove('active', 'paused');
        }

        // 监听 URL 变化
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                const newUrl = location.href;

                // 如果正在下载，弹出确认提示
                if (isDownloading) {
                    // 暂停下载
                    isPaused = true;
                    const pauseBtn = document.querySelector('.pixiv-dl-pause-btn');
                    if (pauseBtn) {
                        pauseBtn.innerHTML = ICONS.play;
                        pauseBtn.classList.add('paused');
                    }

                    const confirmed = confirm('正在下载中，切换页面将取消当前下载。\n\n点击"确定"取消下载并切换页面\n点击"取消"继续下载（在后台继续）');

                    if (confirmed) {
                        // 用户确认取消下载
                        isCancelled = true;
                        isDownloading = false;
                        isPaused = false;
                        lastUrl = newUrl;
                        resetButtonState();
                        console.log('Pixiv Downloader: 下载已取消');
                    } else {
                        // 用户选择继续下载，让下载在后台继续
                        isPaused = false;
                        lastUrl = newUrl;  // 更新 URL 避免重复触发
                        if (pauseBtn) {
                            pauseBtn.innerHTML = ICONS.pause;
                            pauseBtn.classList.remove('paused');
                        }
                        console.log('Pixiv Downloader: 下载将在后台继续');
                    }
                } else {
                    lastUrl = newUrl;
                    resetButtonState();
                }
            }
        });
        observer.observe(document, { subtree: true, childList: true });

        // 监听页面关闭/刷新
        window.addEventListener('beforeunload', (e) => {
            if (isDownloading) {
                e.preventDefault();
                e.returnValue = '下载正在进行中，确定要离开吗？';
                return e.returnValue;
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }


})();
