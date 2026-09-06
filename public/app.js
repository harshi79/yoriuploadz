/* YoriUpload — client logic */
(() => {
  'use strict';

  const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // matches the relay limit
  const KEY_STORAGE = 'yori_upload_key';
  const HISTORY_STORAGE = 'yori_upload_history';
  const HISTORY_MAX = 12;

  const $ = (id) => document.getElementById(id);

  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  const browseBtn = $('browseBtn');
  const lifeSelect = $('life-select');
  const importForm = $('importForm');
  const importUrl = $('importUrl');
  const progressWrap = $('progress');
  const progressBar = $('progressBar');
  const progressText = $('progressText');
  const resultBox = $('result');
  const recentSection = $('recentSection');
  const recentList = $('recentList');
  const toast = $('toast');

  let uploadToken = null;

  /* ------------------------------ helpers ------------------------------ */

  // Share links are served from this site (the file itself is fetched by
  // the viewer page), so the URL people share looks like our own domain.
  function toB64(s) {
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64(s) {
    return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  }
  function shareLink(url) {
    return `${location.origin}/v/${toB64(url)}`;
  }
  function urlBasename(u) {
    try {
      const seg = decodeURIComponent(new URL(u).pathname.split('/').pop() || '').trim();
      return seg || 'file';
    } catch {
      return 'file';
    }
  }
  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label || 'Copied to clipboard');
      return true;
    } catch {
      prompt('Copy the link:', text);
      return false;
    }
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 10 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return sameDay
      ? `today ${hh}:${mm}`
      : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
  }

  function showToast(msg, ms = 2600) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), ms);
  }

  /**
   * Turn any failure into something a human can act on.
   *
   * The relay answers JSON, but the platform in front of it does not: when a
   * function times out or crashes, Netlify replies with plain text or HTML and
   * a 502/504. Those used to fall through to "Something went wrong", which is
   * why failures were impossible to diagnose from the UI.
   */
  function explainFailure(status, data, rawText) {
    if (data && data.error) {
      const attempts = Array.isArray(data.attempts) ? data.attempts.filter((a) => a && a.error) : [];
      const trail = attempts.length
        ? ` (tried ${attempts.map((a) => `${a.provider}: ${a.error || 'HTTP ' + a.status}`).join('; ')})`
        : '';
      return data.error + trail;
    }

    const snippet = String(rawText || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    if (!status) return 'Network error — the request never reached the server. Check your connection and try again.';
    if (status === 413) return 'That file is too large for this deployment (max 4 MB).';
    if (status === 429) return 'Too many uploads in a short time. Wait a minute and try again.';
    if (status === 504 || status === 502) {
      return `The upload relay could not reach storage (HTTP ${status})${snippet ? ` — ${snippet}` : ''}. ` +
        'This is usually a slow or blocked storage provider; try a smaller file or retry in a moment.';
    }
    return `Upload relay error (HTTP ${status})${snippet ? ` — ${snippet}` : ''}`;
  }

  function setProgress(pct, label) {
    progressWrap.classList.remove('hidden');
    progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    progressText.textContent = label;
  }

  function hideProgress() {
    progressWrap.classList.add('hidden');
    progressBar.style.width = '0%';
  }

  /**
   * "Upload failed" is useless on its own, so every error offers a one-click
   * self-check: /api/diag reports, from inside the deployed function, which
   * storage provider is actually reachable and what it said.
   */
  function diagnosticsBlock() {
    const wrap = document.createElement('div');
    wrap.className = 'diag';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost';
    btn.textContent = 'Run diagnostics';
    const out = document.createElement('div');
    out.className = 'diag-out';

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Checking storage…';
      out.replaceChildren();
      try {
        const res = await fetch('/api/diag?live=1', { headers: withToken() });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* not JSON */ }

        if (!data) {
          out.textContent = `Diagnostics unavailable (HTTP ${res.status}). If this is a fresh deploy, redeploy the site so /api/diag exists.`;
        } else {
          const lines = (data.providers || []).map((p) =>
            p.reachable
              ? `${p.label}: reachable (HTTP ${p.status}, ${p.ms} ms)`
              : `${p.label}: unreachable — ${p.error}`
          );
          if (data.liveUpload) {
            lines.push(
              data.liveUpload.ok
                ? `Test upload: OK via ${data.liveUpload.provider}`
                : `Test upload: failed — ${data.liveUpload.error}`
            );
          }
          const ul = document.createElement('ul');
          for (const line of lines) {
            const li = document.createElement('li');
            li.textContent = line;
            ul.appendChild(li);
          }
          out.replaceChildren(ul);
        }
      } catch (err) {
        out.textContent = `Diagnostics request failed: ${(err && err.message) || 'network error'}`;
      }
      btn.disabled = false;
      btn.textContent = 'Run diagnostics again';
    });

    wrap.append(btn, out);
    return wrap;
  }

  function showResult(kind, title, url, meta = {}) {
    resultBox.classList.remove('hidden', 'error', 'ok');
    resultBox.classList.add(kind === 'ok' ? 'ok' : 'error');

    const head = document.createElement('div');
    head.className = 'result-head';
    const h = document.createElement('span');
    h.className = 'result-title';
    h.textContent = title;
    head.appendChild(h);
    if (kind === 'ok') {
      const btns = document.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '8px';
      btns.style.flexWrap = 'wrap';
      btns.style.justifyContent = 'flex-end';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn-primary';
      copyBtn.textContent = 'Copy link';
      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(shareLink(url), 'Link copied — ready to share');
        if (ok) {
          copyBtn.textContent = 'Copied ✓';
          setTimeout(() => (copyBtn.textContent = 'Copy link'), 1600);
        }
      });
      btns.appendChild(copyBtn);

      const directBtn = document.createElement('button');
      directBtn.type = 'button';
      directBtn.className = 'btn btn-ghost';
      directBtn.textContent = 'Direct';
      directBtn.title = 'Copy the raw file URL';
      directBtn.addEventListener('click', () => copyText(url, 'Direct link copied'));
      btns.appendChild(directBtn);

      head.appendChild(btns);
    }

    const body = document.createElement('div');
    if (kind === 'ok') {
      const row = document.createElement('div');
      row.className = 'result-url';
      const input = document.createElement('input');
      input.value = shareLink(url);
      input.readOnly = true;
      input.title = 'Copy this to share the file';
      input.addEventListener('click', () => input.select());
      row.appendChild(input);
      body.appendChild(row);

      if (meta.preview) {
        const img = document.createElement('img');
        img.className = 'result-preview';
        img.src = meta.preview;
        img.alt = 'Uploaded image preview';
        img.loading = 'lazy';
        body.appendChild(img);
      }

      if (meta.name || meta.size || meta.expires) {
        const m = document.createElement('p');
        m.className = 'result-meta';
        m.textContent = [meta.name, meta.size && fmtBytes(meta.size), meta.expires].filter(Boolean).join(' · ');
        body.appendChild(m);
      }
    } else {
      const p = document.createElement('p');
      p.className = 'result-meta';
      p.textContent = url;
      body.appendChild(p);
      body.appendChild(diagnosticsBlock());
    }

    resultBox.replaceChildren(head, body);
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ----------------------------- access key ---------------------------- */

  try {
    uploadToken = localStorage.getItem(KEY_STORAGE);
  } catch { /* storage unavailable */ }

  function withToken(headers = {}) {
    if (uploadToken) headers['x-access-key'] = uploadToken;
    return headers;
  }

  /* ----------------------------- history ------------------------------- */

  function readHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_STORAGE) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function addToHistory(entry) {
    const list = readHistory();
    list.unshift(entry);
    try {
      localStorage.setItem(HISTORY_STORAGE, JSON.stringify(list.slice(0, HISTORY_MAX)));
    } catch { /* quota exceeded — ignore */ }
    renderHistory();
  }

  function renderHistory() {
    const list = readHistory();
    recentSection.hidden = list.length === 0;
    recentList.replaceChildren();

    for (const item of list) {
      const li = document.createElement('li');

      let thumb = null;
      if (item.preview) {
        thumb = document.createElement('img');
        thumb.className = 'recent-thumb';
        thumb.src = item.preview;
        thumb.alt = '';
        thumb.loading = 'lazy';
      } else {
        thumb = document.createElement('span');
        thumb.className = 'recent-thumb';
        thumb.style.display = 'grid';
        thumb.style.placeItems = 'center';
        thumb.textContent = '📦';
      }

      const info = document.createElement('div');
      info.className = 'recent-info';
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = item.name || 'file';
      name.title = item.name || '';
      const sub = document.createElement('span');
      sub.className = 'recent-sub';
      sub.textContent = `${fmtTime(item.at)} · ${fmtBytes(item.size)}`;
      info.append(name, sub);

      const actions = document.createElement('div');
      actions.className = 'recent-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'icon-btn';
      copyBtn.title = 'Copy share link';
      copyBtn.textContent = '🔗';
      copyBtn.addEventListener('click', () => copyText(shareLink(item.url), 'Link copied — ready to share'));
      actions.appendChild(copyBtn);

      li.append(thumb, info, actions);
      recentList.appendChild(li);
    }
  }

  /* ------------------------- image optimization ------------------------ */

  function isImage(file) {
    return file.type && file.type.startsWith('image/');
  }

  /**
   * If an image exceeds the size limit, downscale it to JPEG/WebP. If it
   * still doesn't fit after downscaling, return null so the caller can
   * decide whether to reject it.
   */
  async function optimizeImage(file) {
    try {
      const bitmap = await createImageBitmap(file);
      let scale = Math.min(1, Math.sqrt(MAX_UPLOAD_BYTES / file.size));
      let w = Math.round(bitmap.width * scale);
      let h = Math.round(bitmap.height * scale);
      if (w < 1 || h < 1) return null;

      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();

      const encoders = [
        () => canvas.convertToBlob({ type: 'image/webp', quality: 0.82 }),
        () => canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }),
      ];
      for (const enc of encoders) {
        const blob = await enc();
        if (blob.size > 0 && blob.size <= MAX_UPLOAD_BYTES) {
          return { blob, filename: file.name.replace(/\.(png|jpe?g|webp|bmp|avif|heic)$/i, '') + '.jpg' };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function isDirectFileUrl(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      const host = u.hostname.toLowerCase();
      return !/^(www\.)?(facebook|fb|instagram|twitter|x|tiktok|youtube|youtu\.be|linkedin|reddit|threads|twitch)\./i.test(host);
    } catch {
      return false;
    }
  }

  /* ------------------------------ upload ------------------------------- */

  async function uploadFile(file) {
    // Clear previous result.
    resultBox.classList.add('hidden');

    if (file.size > MAX_UPLOAD_BYTES) {
      const blob = await optimizeImage(file);
      if (!blob) {
        showResult('error', 'File too large', `"${file.name}" is larger than 4 MB and could not be compressed enough. Try a smaller file.`);
        hideProgress();
        return;
      }
      return uploadBlob(blob.blob, blob.filename, true);
    }

    if (file.size === 0) {
      showResult('error', 'Empty file', 'This file is empty, so there is nothing to upload.');
      hideProgress();
      return;
    }

    return uploadBlob(file, file.name, false);
  }

  async function uploadBlob(blob, filename, optimized) {
    if (!filename) filename = 'file';
    if (!(blob instanceof Blob)) return;
    setProgress(4, `Uploading ${filename}…`);

    try {
      // Send the raw binary body so the relay can forward it as-is (no
      // multipart wrapping here — the relay builds the upstream form).
      const xhr = new XMLHttpRequest();
      const promise = new Promise((resolve, reject) => {
        xhr.open('POST', '/api/upload');
        // Always binary content type so the Netlify gateway base64-encodes
        // the raw body for the function; the real MIME goes in x-file-type.
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(filename));
        xhr.setRequestHeader('x-file-type', blob.type || 'application/octet-stream');
        xhr.setRequestHeader('x-expiry', lifeSelect.value);
        if (uploadToken) xhr.setRequestHeader('x-access-key', uploadToken);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = 4 + (e.loaded / e.total) * 88;
            setProgress(pct, `Uploading ${filename}… ${Math.round(pct)}%`);
          }
        };

        xhr.onload = () => {
          const text = xhr.responseText || '';
          let data;
          try { data = JSON.parse(text); } catch { data = null; }
          resolve({ status: xhr.status, data, text });
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Request timed out'));
        xhr.timeout = 120000;
        xhr.send(blob);
      });

      const res = await promise;
      hideProgress();

      if (res.status === 200 && res.data && res.data.ok) {
        const url = res.data.url;
        const type = res.data.type || blob.type || '';
        const isVector = type === 'image/svg+xml';
        const preview = type.startsWith('image/') && !isVector ? url : null;

        const entry = {
          url,
          name: res.data.name || filename,
          size: res.data.size || Math.min(blob.size, MAX_UPLOAD_BYTES),
          at: Date.now(),
          preview,
        };
        addToHistory(entry);

        const expiryMap = {
          '1h': 'expires in 1 hour',
          '12h': 'expires in 12 hours',
          '24h': 'expires in 24 hours',
          '72h': 'expires in 72 hours',
          permanent: 'permanent link',
        };
        const expiry = expiryMap[res.data.expires] || expiryMap[lifeSelect.value] || '';
        const notes = [];
        if (optimized) notes.push('image auto-optimized');
        if (res.data.note) notes.push(res.data.note);
        else if (expiry) notes.push(expiry);

        showResult('ok', 'Upload complete!', url, {
          name: entry.name,
          size: entry.size,
          preview,
          expires: notes.join(' · '),
        });
      } else if (res.status === 403) {
        const key = prompt(res.data && res.data.error
          ? `${res.data.error} Enter your access key:`
          : 'This site is private. Enter your access key:');
        if (key) {
          uploadToken = key;
          try { localStorage.setItem(KEY_STORAGE, key); } catch { /* ignore */ }
          showToast('Key saved — retrying upload…');
          return uploadBlob(blob, filename, optimized);
        }
        showResult('error', 'Private site', 'No access key — upload blocked.', '');
      } else {
        showResult('error', 'Upload failed', explainFailure(res.status, res.data, res.text));
      }
    } catch (err) {
      hideProgress();
      showResult('error', 'Upload failed', (err && err.message) || 'Network error. Check your connection and try again.');
    }
  }

  /* --------------------------- url import ------------------------------ */

  async function importFromUrl(url) {
    resultBox.classList.add('hidden');
    setProgress(10, 'Fetching file from URL…');
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...withToken() },
        body: JSON.stringify({ url }),
      });
      const rawText = await res.text();
      let data = null;
      try { data = JSON.parse(rawText); } catch { /* platform error page, not JSON */ }
      hideProgress();

      if (res.ok && data && data.ok) {
        let preview = null;
        if (/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(data.url)) preview = data.url;
        addToHistory({ url: data.url, name: nameFromUrl(data.url), size: 0, at: Date.now(), preview });
        showResult('ok', 'Import complete!', data.url, { preview, expires: data.note || '' });
      } else if (res.status === 403) {
        const key = prompt((data && data.error) || 'Enter your access key:');
        if (key) {
          uploadToken = key;
          try { localStorage.setItem(KEY_STORAGE, key); } catch { /* ignore */ }
          return importFromUrl(url);
        }
        showResult('error', 'Private site', 'No access key — import blocked.');
      } else {
        showResult('error', 'Import failed', explainFailure(res.status, data, rawText));
      }
    } catch (err) {
      hideProgress();
      showResult('error', 'Import failed', (err && err.message) || 'Network error.');
    }
  }

  function nameFromUrl(url) {
    try {
      const path = new URL(url).pathname;
      const name = decodeURIComponent(path.split('/').pop() || '');
      return name && name.length > 2 ? name : 'file';
    } catch {
      return 'file';
    }
  }

  /* --------------------------- share viewer ---------------------------- */

  const viewerSection = $('viewer');
  const viewerBody = $('viewerBody');

  function viewerActions(target) {
    const actions = document.createElement('div');
    actions.className = 'viewer-actions';

    const download = document.createElement('a');
    download.className = 'btn btn-primary';
    download.href = target;
    download.target = '_blank';
    download.rel = 'noopener noreferrer';
    download.textContent = 'Download file';
    actions.appendChild(download);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-ghost';
    copy.textContent = 'Copy direct link';
    copy.addEventListener('click', () => copyText(target, 'Direct link copied'));
    actions.appendChild(copy);

    return actions;
  }

  function viewerHeader(name, sub) {
    const wrap = document.createElement('div');
    const icon = document.createElement('div');
    icon.className = 'viewer-file-icon';
    icon.textContent = '📦';
    const title = document.createElement('h2');
    title.className = 'viewer-body-title';
    title.textContent = name;
    const note = document.createElement('p');
    note.className = 'viewer-body-sub';
    note.textContent = sub;
    wrap.append(icon, title, note);
    return wrap;
  }

  function renderViewer(payload) {
    let target = null;
    try { target = fromB64(payload); } catch { /* ignore */ }

    const valid = target && /^https?:\/\//i.test(target);
    if (!valid) {
      viewerSection.classList.remove('hidden');
      const title = document.createElement('h2');
      title.className = 'viewer-body-title';
      title.textContent = 'This link looks invalid';
      const note = document.createElement('p');
      note.className = 'viewer-body-sub';
      note.textContent = 'The shared file link couldn’t be opened here. Ask the sender for a fresh link.';
      viewerBody.replaceChildren(title, note);
      return;
    }

    // Image links get an inline preview; everything else shows a download card.
    const looksLikeImage = /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(target);
    const name = urlBasename(target);
    const note = document.createElement('p');
    note.className = 'viewer-body-sub';
    note.textContent = 'Shared via YoriUpload — links may expire or be removed by their owner.';

    if (looksLikeImage) {
      const img = document.createElement('img');
      img.className = 'viewer-image';
      img.alt = 'Shared file';
      img.loading = 'eager';
      const fallback = () => {
        viewerBody.replaceChildren(viewerHeader(name, 'This shared file is available to download.'), viewerActions(target));
      };
      img.onload = () => {
        note.textContent = `${name} · displayed by YoriUpload`;
        viewerBody.replaceChildren(viewerHeader(name, note.textContent), img, viewerActions(target));
      };
      img.onerror = fallback;
      const title = document.createElement('h2');
      title.className = 'viewer-body-title';
      title.textContent = 'Opening shared file…';
      viewerSection.classList.remove('hidden');
      viewerBody.replaceChildren(title, img);
      img.src = target; // kick off the load
    } else {
      viewerSection.classList.remove('hidden');
      viewerBody.replaceChildren(
        viewerHeader(name, 'This shared file is available to download.'),
        viewerActions(target)
      );
    }
  }

  /* ------------------------------ events ------------------------------- */

  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    })
  );

  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) uploadFile(file);
    fileInput.value = '';
  });

  document.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          uploadFile(f);
          return;
        }
      }
    }
  });

  importForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = importUrl.value.trim();
    if (!url) return;
    if (!isDirectFileUrl(url)) {
      showResult('error', 'Invalid link', 'Please paste the full direct URL of the file (ending in the file name or being an image/file link).');
      return;
    }
    importFromUrl(url);
    importUrl.value = '';
  });

  $('clearHistory').addEventListener('click', () => {
    try { localStorage.removeItem(HISTORY_STORAGE); } catch { /* ignore */ }
    renderHistory();
    showToast('History cleared');
  });

  if (location.pathname.startsWith('/v/')) {
    const shareMatch = location.pathname.match(/^\/v\/([A-Za-z0-9_-]+)\/?$/);
    document.body.classList.add('viewing');
    renderViewer(shareMatch ? shareMatch[1] : '');
  } else {
    renderHistory();
  }
})();
