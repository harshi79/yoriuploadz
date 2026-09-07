(() => {
  'use strict';

  const UPLOAD_ENDPOINT = '/api/upload';
  const MAX_UPLOAD_BYTES = 200_000_000;
  const HISTORY_KEY = 'yori_upload_history_v3';
  const HISTORY_LIMIT = 10;
  const TRUSTED_HOST = 'files.catbox.moe';
  const BLOCKED_EXTENSIONS = new Set(['exe', 'scr', 'cpl', 'jar']);

  const byId = (id) => document.getElementById(id);
  const homeView = byId('homeView');
  const viewerView = byId('viewerView');
  const fileInput = byId('fileInput');
  const dropzone = byId('dropzone');
  const idleView = byId('idleView');
  const progressView = byId('progressView');
  const outcomeView = byId('outcomeView');
  const panelState = byId('panelState');
  const uploader = byId('uploader');
  const networkState = byId('networkState');
  const networkText = byId('networkText');
  const toast = byId('toast');

  let activeFile = null;
  let activeRequest = null;
  let requestVersion = 0;
  let previewUrl = '';
  let currentEntry = null;
  let dragDepth = 0;
  let downloadTimer = 0;

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / 1024 ** index;
    const digits = amount >= 100 || index === 0 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${units[index]}`;
  }

  function formatDate(value) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function fileKind(name, type = '') {
    const mime = String(type).toLowerCase();
    if (mime.startsWith('image/')) return 'IMG';
    if (mime.startsWith('video/')) return 'VID';
    if (mime.startsWith('audio/')) return 'AUD';
    if (mime === 'application/pdf') return 'PDF';

    const cleanName = String(name || '');
    const dot = cleanName.lastIndexOf('.');
    const extension = dot > -1 ? cleanName.slice(dot + 1).replace(/[^a-z0-9]/gi, '') : '';
    return extension ? extension.slice(0, 4).toUpperCase() : 'FILE';
  }

  function displayName(value) {
    const cleaned = String(value || '')
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/[\\/]+/g, '-')
      .trim();
    return Array.from(cleaned || 'Shared file').slice(0, 180).join('');
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Link copied');
      return true;
    } catch {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.className = 'clipboard-fallback';
      document.body.appendChild(field);
      field.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      field.remove();
      showToast(copied ? 'Link copied' : 'Copy unavailable');
      return copied;
    }
  }

  function trustedSharePath(value) {
    const path = String(value || '');
    return /^\/v\/[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43}$/.test(path) ? path : '';
  }

  function makeShareLink(entry) {
    const sharePath = entry && trustedSharePath(entry.sharePath);
    return sharePath ? `${location.origin}${sharePath}` : '';
  }

  function base64UrlToBytes(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function decodeSharePayload(value) {
    const match = String(value || '').match(/^([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return null;
    try {
      const decoded = new TextDecoder().decode(base64UrlToBytes(match[1]));
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed.u === 'string') {
        return {
          url: parsed.u,
          name: displayName(parsed.n),
          size: Number(parsed.s) || 0,
          type: String(parsed.t || '').slice(0, 100),
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  function trustedUrl(value) {
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.hostname.toLowerCase() !== TRUSTED_HOST ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/[A-Za-z0-9._-]+$/.test(url.pathname)
      ) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function setView(view) {
    idleView.hidden = view !== 'idle';
    progressView.hidden = view !== 'progress';
    outcomeView.hidden = view !== 'outcome';
    uploader.setAttribute('aria-busy', view === 'progress' ? 'true' : 'false');
    panelState.textContent = view === 'progress' ? 'UPLOADING' : view === 'outcome' ? 'COMPLETE' : 'IDLE';
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    byId('previewImage').removeAttribute('src');
    byId('imagePreview').hidden = true;
  }

  function resetUploader() {
    requestVersion += 1;
    if (activeRequest) activeRequest.abort();
    activeRequest = null;
    activeFile = null;
    currentEntry = null;
    fileInput.value = '';
    clearPreview();
    byId('progressBar').value = 0;
    byId('progressBar').textContent = '0%';
    byId('progressPercent').textContent = '0%';
    outcomeView.classList.remove('is-error');
    setView('idle');
    dropzone.focus({ preventScroll: true });
  }

  function setProgress(percent, text) {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    byId('progressBar').value = safePercent;
    byId('progressBar').textContent = `${safePercent}%`;
    byId('progressPercent').textContent = `${safePercent}%`;
    byId('progressText').textContent = text;
  }

  function explainUploadFailure(status, response) {
    if (!navigator.onLine || status === 0) return 'Connection lost. Check your network and retry.';
    if (response && typeof response.error === 'string' && response.error.trim()) {
      return response.error.trim().slice(0, 240);
    }
    if (status === 413) return 'Maximum file size is 200 MB.';
    if (status === 429) return 'Too many uploads. Wait a minute and retry.';
    if (status === 503) return 'Permanent storage is not configured.';
    if (status >= 500) return 'Storage is temporarily unavailable. Retry in a moment.';
    return 'The upload could not be completed. Please retry.';
  }

  function showError(message, canRetry = true) {
    currentEntry = null;
    clearPreview();
    outcomeView.classList.add('is-error');
    byId('outcomeLabel').textContent = 'UPLOAD FAILED';
    byId('outcomeTitle').textContent = 'Not uploaded.';
    byId('outcomeMessage').textContent = message;
    byId('shareControl').hidden = true;
    byId('openLink').hidden = true;
    byId('shareLink').hidden = true;
    byId('retryUpload').hidden = !canRetry || !activeFile;
    byId('newUpload').textContent = 'Choose another';
    setView('outcome');
    panelState.textContent = 'ERROR';
    byId('outcomeTitle').focus({ preventScroll: true });
  }

  function showSuccess(file, sharePath) {
    const entry = {
      sharePath,
      name: displayName(file.name),
      size: file.size,
      type: file.type || '',
      at: Date.now(),
    };
    const shareUrl = makeShareLink(entry);
    currentEntry = entry;

    outcomeView.classList.remove('is-error');
    byId('outcomeLabel').textContent = 'UPLOAD COMPLETE';
    byId('outcomeTitle').textContent = 'Link ready.';
    byId('outcomeMessage').textContent = `${entry.name} · ${formatBytes(entry.size)}`;
    byId('shareUrl').value = shareUrl;
    byId('shareControl').hidden = false;
    byId('openLink').hidden = false;
    byId('openLink').href = shareUrl;
    byId('retryUpload').hidden = true;
    byId('newUpload').textContent = 'New upload';
    byId('shareLink').hidden = typeof navigator.share !== 'function';

    clearPreview();
    if (entry.type.startsWith('image/') && entry.type !== 'image/svg+xml') {
      previewUrl = URL.createObjectURL(file);
      byId('previewImage').src = previewUrl;
      byId('imagePreview').hidden = false;
    }

    addHistory(entry);
    setProgress(100, 'Complete');
    setView('outcome');
    byId('outcomeTitle').focus({ preventScroll: true });
  }

  function uploadFile(file) {
    if (!(file instanceof File)) return;
    if (file.size < 1) {
      activeFile = null;
      showError('This file is empty.', false);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      activeFile = file;
      showError('Maximum file size is 200 MB.', false);
      return;
    }

    const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    if (BLOCKED_EXTENSIONS.has(extension) || extension.startsWith('doc')) {
      activeFile = file;
      showError(`Catbox does not accept .${extension} files.`, false);
      return;
    }
    if (extension === 'gif' && file.size > 20_000_000) {
      activeFile = file;
      showError('Catbox limits GIF files to 20 MB.', false);
      return;
    }
    if (!navigator.onLine) {
      activeFile = file;
      showError('You are offline. Reconnect and retry.', true);
      return;
    }

    activeFile = file;
    currentEntry = null;
    clearPreview();
    outcomeView.classList.remove('is-error');
    byId('progressName').textContent = displayName(file.name);
    byId('progressSize').textContent = formatBytes(file.size);
    byId('progressKind').textContent = fileKind(file.name, file.type);
    setProgress(0, 'Connecting');
    setView('progress');

    const version = ++requestVersion;
    const request = new XMLHttpRequest();
    activeRequest = request;
    request.open('POST', UPLOAD_ENDPOINT);
    request.responseType = 'text';
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('x-yori-upload', '1');
    request.setRequestHeader('x-file-name', encodeURIComponent(displayName(file.name)));
    request.setRequestHeader('x-file-type', file.type || 'application/octet-stream');

    request.upload.addEventListener('progress', (event) => {
      if (version !== requestVersion) return;
      if (!event.lengthComputable) {
        setProgress(4, 'Uploading');
        return;
      }
      const percent = Math.min(95, (event.loaded / event.total) * 95);
      setProgress(percent, event.loaded === event.total ? 'Saving permanently' : 'Uploading');
    });

    request.addEventListener('load', () => {
      if (version !== requestVersion) return;
      activeRequest = null;
      let response = null;
      try {
        response = JSON.parse(request.responseText || '{}');
      } catch {
        response = null;
      }

      const sharePath = response && trustedSharePath(response.sharePath);
      if (request.status >= 200 && request.status < 300 && response && response.ok === true && response.permanent === true && sharePath) {
        showSuccess(file, sharePath);
      } else {
        showError(explainUploadFailure(request.status, response), request.status !== 415);
      }
    });

    request.addEventListener('error', () => {
      if (version !== requestVersion) return;
      activeRequest = null;
      showError(explainUploadFailure(0, null), true);
    });

    request.addEventListener('abort', () => {
      if (version !== requestVersion) return;
      activeRequest = null;
      showError('Upload cancelled.', true);
    });

    request.send(file);
  }

  function readHistory() {
    try {
      const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(stored)) return [];
      return stored
        .filter((item) => item && trustedSharePath(item.sharePath))
        .map((item) => ({
          sharePath: trustedSharePath(item.sharePath),
          name: displayName(item.name),
          size: Number(item.size) || 0,
          type: String(item.type || '').slice(0, 100),
          at: Number(item.at) || Date.now(),
        }))
        .slice(0, HISTORY_LIMIT);
    } catch {
      return [];
    }
  }

  function addHistory(entry) {
    const history = readHistory().filter((item) => item.sharePath !== entry.sharePath);
    history.unshift(entry);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
    } catch {
      // Upload success should not depend on local history being available.
    }
    renderHistory();
  }

  function renderHistory() {
    const section = byId('recentSection');
    const list = byId('recentList');
    const history = readHistory();
    section.hidden = history.length === 0;
    list.replaceChildren();

    for (const item of history) {
      const row = document.createElement('li');
      row.className = 'recent-item';

      const kind = document.createElement('span');
      kind.className = 'recent-kind';
      kind.textContent = fileKind(item.name, item.type);

      const info = document.createElement('div');
      info.className = 'recent-info';
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = item.name;
      name.title = item.name;
      const time = document.createElement('span');
      time.className = 'recent-time';
      time.textContent = formatDate(item.at);
      info.append(name, time);

      const size = document.createElement('span');
      size.className = 'recent-size';
      size.textContent = formatBytes(item.size);

      const actions = document.createElement('div');
      actions.className = 'recent-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', `Copy link for ${item.name}`);
      copy.addEventListener('click', () => copyText(makeShareLink(item)));
      const open = document.createElement('a');
      open.href = makeShareLink(item);
      open.textContent = 'View';
      open.setAttribute('aria-label', `View download for ${item.name}`);
      actions.append(copy, open);

      row.append(kind, info, size, actions);
      list.appendChild(row);
    }
  }

  function updateNetworkState() {
    const online = navigator.onLine;
    networkState.classList.toggle('offline', !online);
    networkText.textContent = online ? 'READY' : 'OFFLINE';
  }

  async function prepareViewerDownload(payload) {
    const button = byId('viewerDownload');
    const status = byId('viewerStatus');
    const fill = byId('countdownFill');

    try {
      const response = await fetch(`/api/download-ticket?share=${encodeURIComponent(payload)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok !== true) {
        throw new Error(data && data.error ? data.error : 'Download could not be prepared.');
      }
      if (typeof data.downloadPath !== 'string' || !data.downloadPath.startsWith(`/d/${payload}?ticket=`)) {
        throw new Error('Download could not be prepared.');
      }

      const waitMs = Math.max(5_000, Number(data.waitMs) || 5_000);
      const startedAt = performance.now();
      const tick = () => {
        const elapsed = performance.now() - startedAt;
        const remaining = Math.max(0, waitMs - elapsed);
        const seconds = Math.ceil(remaining / 1000);
        fill.style.transform = `scaleX(${Math.min(1, elapsed / waitMs)})`;

        if (remaining > 0) {
          status.textContent = `Download ready in ${seconds} second${seconds === 1 ? '' : 's'}`;
          downloadTimer = window.setTimeout(tick, 100);
          return;
        }

        fill.style.transform = 'scaleX(1)';
        status.textContent = 'Download ready';
        button.href = data.downloadPath;
        button.setAttribute('download', '');
        button.setAttribute('aria-disabled', 'false');
        button.removeAttribute('tabindex');
        button.classList.remove('is-disabled');
      };
      tick();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message.slice(0, 200) : 'Download could not be prepared.';
      fill.style.transform = 'scaleX(0)';
      button.hidden = true;
    }
  }

  function renderViewer(payload) {
    const entry = decodeSharePayload(payload);
    const target = entry && trustedUrl(entry.url);
    const download = byId('viewerDownload');
    homeView.hidden = true;
    viewerView.hidden = false;
    document.querySelector('.skip-link').hidden = true;

    download.addEventListener('click', (event) => {
      if (download.getAttribute('aria-disabled') !== 'false') event.preventDefault();
    });

    if (!entry || !target) {
      byId('viewerKind').textContent = 'ERR';
      byId('viewerName').textContent = 'Invalid link';
      byId('viewerMeta').textContent = 'This shared link cannot be opened.';
      byId('viewerStatus').textContent = 'Download unavailable';
      document.title = 'Invalid link — Yori';
      download.hidden = true;
      byId('viewerCopy').hidden = true;
      return;
    }

    byId('viewerKind').textContent = fileKind(entry.name, entry.type);
    byId('viewerName').textContent = entry.name;
    byId('viewerMeta').textContent = [entry.size ? formatBytes(entry.size) : '', 'Permanent file'].filter(Boolean).join(' · ');
    document.title = `${entry.name} — Yori`;
    byId('viewerCopy').addEventListener('click', () => copyText(location.href));
    prepareViewerDownload(payload);
  }

  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) uploadFile(file);
  });

  for (const eventName of ['dragenter', 'dragover']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (eventName === 'dragenter') dragDepth += 1;
      dropzone.classList.add('is-dragging');
    });
  }

  dropzone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('is-dragging');
  });

  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-dragging');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-dragging');
  });
  window.addEventListener('dragend', () => {
    dragDepth = 0;
    dropzone.classList.remove('is-dragging');
  });

  document.addEventListener('paste', (event) => {
    if (homeView.hidden || idleView.hidden || !event.clipboardData) return;
    let file = event.clipboardData.files && event.clipboardData.files[0];
    if (!file) {
      const item = Array.from(event.clipboardData.items || []).find((candidate) => candidate.kind === 'file');
      file = item && item.getAsFile();
    }
    if (file) {
      event.preventDefault();
      uploadFile(file);
    }
  });

  byId('cancelUpload').addEventListener('click', () => {
    requestVersion += 1;
    if (activeRequest) activeRequest.abort();
    activeRequest = null;
    activeFile = null;
    fileInput.value = '';
    setView('idle');
    dropzone.focus({ preventScroll: true });
    showToast('Upload cancelled');
  });

  byId('retryUpload').addEventListener('click', () => {
    if (activeFile) uploadFile(activeFile);
  });

  byId('newUpload').addEventListener('click', resetUploader);
  byId('copyLink').addEventListener('click', () => copyText(byId('shareUrl').value));
  byId('shareUrl').addEventListener('click', (event) => event.currentTarget.select());

  byId('shareLink').addEventListener('click', async () => {
    if (!currentEntry || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({ title: currentEntry.name, url: makeShareLink(currentEntry) });
    } catch (error) {
      if (error && error.name !== 'AbortError') showToast('Could not open share menu');
    }
  });

  byId('clearHistory').addEventListener('click', () => {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      // The UI can still clear even if storage is blocked.
    }
    renderHistory();
    showToast('History cleared');
  });

  window.addEventListener('online', updateNetworkState);
  window.addEventListener('offline', updateNetworkState);
  window.addEventListener('beforeunload', () => {
    clearPreview();
    clearTimeout(downloadTimer);
  });

  const viewerMatch = location.pathname.match(/^\/v\/([A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43})\/?$/);
  updateNetworkState();
  if (viewerMatch) {
    renderViewer(viewerMatch[1]);
  } else {
    renderHistory();
  }
})();
