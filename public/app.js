(() => {
  'use strict';

  const UPLOAD_ENDPOINT = 'https://upload.gofile.io/uploadfile';
  const HISTORY_KEY = 'yori_upload_history';
  const GUEST_TOKEN_KEY = 'yori_gofile_guest_token';
  const HISTORY_LIMIT = 10;
  const TRUSTED_HOSTS = new Set([
    'gofile.io',
    'files.catbox.moe',
    'litter.catbox.moe',
    'tmpfiles.org',
    '0x0.st',
    'storage.to',
  ]);

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

  function readGuestToken() {
    try {
      const token = localStorage.getItem(GUEST_TOKEN_KEY) || '';
      return /^[A-Za-z0-9._~-]{16,512}$/.test(token) ? token : '';
    } catch {
      return '';
    }
  }

  function saveGuestToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{16,512}$/.test(token)) return;
    try {
      localStorage.setItem(GUEST_TOKEN_KEY, token);
    } catch {
      // A guest token is optional; uploads still work without localStorage.
    }
  }

  function clearGuestToken() {
    try {
      localStorage.removeItem(GUEST_TOKEN_KEY);
    } catch {
      // Nothing else is required when localStorage is unavailable.
    }
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

  function bytesToBase64Url(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function makeShareLink(entry) {
    const payload = JSON.stringify({
      u: entry.url,
      n: entry.name || 'Shared file',
      s: Number(entry.size) || 0,
      t: entry.type || '',
    });
    const encoded = bytesToBase64Url(new TextEncoder().encode(payload));
    return `${location.origin}/v/${encoded}`;
  }

  function decodeSharePayload(value) {
    if (typeof value !== 'string' || value.length > 4096) return null;
    try {
      const decoded = new TextDecoder().decode(base64UrlToBytes(value));
      try {
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
        // Links from the previous version stored only the URL.
        return { url: decoded, name: 'Shared file', size: 0, type: '' };
      }
    } catch {
      return null;
    }
    return null;
  }

  function trustedUrl(value, gofileOnly = false) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return null;
      const host = url.hostname.toLowerCase();
      const isGofile = host === 'gofile.io' || host.endsWith('.gofile.io');
      if (gofileOnly && !isGofile) return null;
      if (!isGofile && !TRUSTED_HOSTS.has(host)) return null;
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
    const code = response && response.status;
    if (!navigator.onLine || status === 0) return 'Connection lost. Check your network and retry.';
    if (status === 413) return 'The storage service rejected this file as too large.';
    if (status === 429 || code === 'error-rateLimit') return 'Upload limit reached. Wait a moment and retry.';
    if (code === 'error-limits') return 'The guest storage limit was reached. Try again later.';
    if (status >= 500) return 'Storage is temporarily unavailable. Retry in a moment.';
    if (code && code !== 'ok') return `GoFile returned ${String(code).replace(/^error-/, '')}.`;
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

  function showSuccess(file, providerUrl) {
    const entry = {
      url: providerUrl,
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
    byId('openLink').href = providerUrl;
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

  function uploadFile(file, ignoreSavedToken = false) {
    if (!(file instanceof File)) return;
    if (file.size < 1) {
      activeFile = null;
      showError('This file is empty.', false);
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
    const form = new FormData();
    const guestToken = ignoreSavedToken ? '' : readGuestToken();
    form.append('file', file, file.name || 'file');
    if (guestToken) form.append('token', guestToken);

    const request = new XMLHttpRequest();
    activeRequest = request;
    request.open('POST', UPLOAD_ENDPOINT);
    request.responseType = 'text';

    request.upload.addEventListener('progress', (event) => {
      if (version !== requestVersion) return;
      if (!event.lengthComputable) {
        setProgress(4, 'Uploading');
        return;
      }
      const percent = Math.min(95, (event.loaded / event.total) * 95);
      setProgress(percent, event.loaded === event.total ? 'Processing' : 'Uploading');
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

      const providerUrl = response && response.data && trustedUrl(response.data.downloadPage, true);
      if (request.status >= 200 && request.status < 300 && response && response.status === 'ok' && providerUrl) {
        saveGuestToken(response.data.guestToken);
        showSuccess(file, providerUrl);
      } else if (guestToken && response && response.status === 'error-token') {
        clearGuestToken();
        uploadFile(file, true);
      } else {
        showError(explainUploadFailure(request.status, response), true);
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

    request.send(form);
  }

  function readHistory() {
    try {
      const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(stored)) return [];
      return stored
        .filter((item) => item && trustedUrl(item.url))
        .map((item) => ({
          url: trustedUrl(item.url),
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
    const history = readHistory().filter((item) => item.url !== entry.url);
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
      open.href = item.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'Open';
      open.setAttribute('aria-label', `Open ${item.name}`);
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

  function renderViewer(payload) {
    const entry = decodeSharePayload(payload);
    const target = entry && trustedUrl(entry.url);
    homeView.hidden = true;
    viewerView.hidden = false;
    document.querySelector('.skip-link').hidden = true;

    if (!entry || !target) {
      byId('viewerKind').textContent = 'ERR';
      byId('viewerName').textContent = 'Invalid link';
      byId('viewerMeta').textContent = 'This shared link cannot be opened.';
      document.title = 'Invalid link — Yori';
      byId('viewerOpen').hidden = true;
      byId('viewerCopy').hidden = true;
      return;
    }

    const provider = new URL(target).hostname.endsWith('gofile.io') ? 'Hosted by GoFile' : 'Hosted externally';
    byId('viewerKind').textContent = fileKind(entry.name, entry.type);
    byId('viewerName').textContent = entry.name;
    byId('viewerMeta').textContent = [entry.size ? formatBytes(entry.size) : '', provider].filter(Boolean).join(' · ');
    byId('viewerOpen').href = target;
    document.title = `${entry.name} — Yori`;
    byId('viewerCopy').addEventListener('click', () => copyText(location.href));
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
  window.addEventListener('beforeunload', clearPreview);

  const viewerMatch = location.pathname.match(/^\/v\/([A-Za-z0-9_-]+)\/?$/);
  updateNetworkState();
  if (viewerMatch) {
    renderViewer(viewerMatch[1]);
  } else {
    renderHistory();
  }
})();
