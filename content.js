(() => {
  'use strict';

  const VERSION = '0.3.2';
  const EXPORT_ID = 'obsidian-chatgpt-export';
  const CONTROLS_ID = 'chatgpt-obsidian-archive-controls';
  const ARCHIVE_BUTTON_ID = 'chatgpt-obsidian-archive-button';
  const DIAG_BUTTON_ID = 'chatgpt-obsidian-archive-diagnostics';
  const STATUS_ID = 'chatgpt-obsidian-archive-status';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TURN_TESTID_RE = /^conversation-turn-(\d+)$/;
  const USER_CALLOUT_MARKER = 'CHATGPTARCHIVEUSERCALLOUT';
  const AI_CONTEXT_META_NAME = 'chatgpt-archive-context';

  const state = {
    busy: false,
    archiveMode: false,
    routeKey: location.href,
    captured: new Map(), // turnNumber -> Element
    expectedTotal: 0,
    scrollContainer: null,
    originalScrollTop: 0,
    originalWindowScrollY: 0,
    main: null,
    originalMainNodes: [],
    originalContextMeta: null,
    imageCache: new Map(),
    imageStats: { protected: 0, public: 0, inline: 0, failed: 0 },
    diagnostics: {
      startedAt: null,
      initialSlotCount: 0,
      finalSlotCount: 0,
      initialMounted: [],
      finalMounted: [],
      passes: [],
      missing: []
    }
  };

  function isConversationPage() {
    return /^\/c\/[0-9a-z-]+/i.test(location.pathname);
  }

  function isObsidianReaderActive() {
    return document.documentElement.classList.contains('obsidian-reader-active') ||
      !!document.querySelector('.obsidian-reader-container');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function setStatus(text, visible = true) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.textContent = text;
    el.dataset.visible = visible ? 'true' : 'false';
  }

  function setArchiveButton(text, disabled = false) {
    const el = document.getElementById(ARCHIVE_BUTTON_ID);
    if (!el) return;
    el.textContent = text;
    el.disabled = disabled;
  }

  function setDiagnosticsVisible(visible) {
    const el = document.getElementById(DIAG_BUTTON_ID);
    if (el) el.style.display = visible ? 'inline-flex' : 'none';
  }

  function ensureControls() {
    let controls = document.getElementById(CONTROLS_ID);
    if (!controls) {
      controls = document.createElement('div');
      controls.id = CONTROLS_ID;

      const status = document.createElement('div');
      status.id = STATUS_ID;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');

      const row = document.createElement('div');
      row.className = 'chatgpt-obsidian-archive-button-row';

      const diagnostics = document.createElement('button');
      diagnostics.id = DIAG_BUTTON_ID;
      diagnostics.type = 'button';
      diagnostics.textContent = 'Copy diagnostics';
      diagnostics.style.display = 'none';
      diagnostics.addEventListener('click', copyDiagnostics);

      const archive = document.createElement('button');
      archive.id = ARCHIVE_BUTTON_ID;
      archive.type = 'button';
      archive.textContent = 'ChatGPT Archive';
      archive.addEventListener('click', onArchiveButtonClick);

      row.append(diagnostics, archive);
      controls.append(status, row);
      document.documentElement.appendChild(controls);
    }

    controls.style.display = isConversationPage() ? 'flex' : 'none';
  }

  function getMainElement() {
    return document.querySelector('main#main') || document.querySelector('main');
  }

  function getConversationThread() {
    const byId = document.getElementById('thread');
    if (byId) return byId;

    const byClass = document.querySelector('.group\\/thread');
    if (byClass) return byClass;

    const firstTurn = document.querySelector('section[data-testid^="conversation-turn-"][data-turn]');
    if (!firstTurn) return null;

    let node = firstTurn.parentElement;
    let best = null;
    while (node && node !== document.body) {
      const count = node.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn]').length;
      if (count >= 2) best = node;
      if (node.tagName === 'MAIN') break;
      node = node.parentElement;
    }
    return best;
  }

  function parseTurnNumber(section) {
    const testId = section.getAttribute('data-testid') || '';
    const match = testId.match(TURN_TESTID_RE);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function getMountedTurnSections(thread = getConversationThread()) {
    if (!thread) return [];
    return Array.from(thread.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn]'))
      .filter(section => parseTurnNumber(section) !== null);
  }

  function getMountedTurnNumbers(thread = getConversationThread()) {
    return getMountedTurnSections(thread)
      .map(parseTurnNumber)
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
  }

  function getUniqueTurnSlotElements(thread = getConversationThread()) {
    if (!thread) return [];
    const seen = new Set();
    const slots = [];

    for (const el of thread.querySelectorAll('[data-turn-id-container]')) {
      const id = el.getAttribute('data-turn-id-container') || '';
      if (!UUID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);

      // Prefer the outer div used by ChatGPT's virtualizer when available.
      const escaped = CSS.escape(id);
      const outer = thread.querySelector(`div[data-turn-id-container="${escaped}"]`) || el;
      slots.push(outer);
    }
    return slots;
  }

  function refreshExpectedTotal(thread = getConversationThread()) {
    const slotCount = getUniqueTurnSlotElements(thread).length;
    const mounted = getMountedTurnNumbers(thread);
    const maxMounted = mounted.length ? Math.max(...mounted) : 0;
    const maxCaptured = state.captured.size ? Math.max(...state.captured.keys()) : 0;
    state.expectedTotal = Math.max(state.expectedTotal, slotCount, maxMounted, maxCaptured);
    return state.expectedTotal;
  }

  function getMissingTurnNumbers() {
    const expected = state.expectedTotal;
    const missing = [];
    for (let i = 1; i <= expected; i += 1) {
      if (!state.captured.has(i)) missing.push(i);
    }
    return missing;
  }

  function isComplete() {
    if (!state.expectedTotal) return false;
    return getMissingTurnNumbers().length === 0;
  }

  function findScrollContainer(startEl) {
    let el = startEl?.parentElement || null;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 20) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isDocumentScroller(scroller) {
    return !scroller || scroller === document.scrollingElement ||
      scroller === document.documentElement || scroller === document.body;
  }

  function getScrollTop(scroller) {
    return isDocumentScroller(scroller) ? window.scrollY : scroller.scrollTop;
  }

  function setScrollTop(scroller, value) {
    const top = Math.max(0, value);
    if (isDocumentScroller(scroller)) {
      window.scrollTo({ top, behavior: 'auto' });
    } else {
      scroller.scrollTop = top;
    }
  }

  function getViewportHeight(scroller) {
    return isDocumentScroller(scroller) ? window.innerHeight : scroller.clientHeight;
  }

  function getScrollHeight(scroller) {
    return isDocumentScroller(scroller)
      ? Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
      : scroller.scrollHeight;
  }

  function getMaxScroll(scroller) {
    return Math.max(0, getScrollHeight(scroller) - getViewportHeight(scroller));
  }

  function rememberScrollPosition(scroller) {
    state.originalWindowScrollY = window.scrollY;
    state.originalScrollTop = isDocumentScroller(scroller) ? window.scrollY : scroller.scrollTop;
  }

  function restoreScrollPosition() {
    const scroller = state.scrollContainer;
    if (isDocumentScroller(scroller)) {
      window.scrollTo({ top: state.originalWindowScrollY, behavior: 'auto' });
    } else if (scroller) {
      scroller.scrollTop = state.originalScrollTop;
    }
  }

  async function scrollAndSettle(scroller, top, waitMs = 120) {
    setScrollTop(scroller, top);
    await nextFrame();
    await sleep(waitMs);
  }

  function isProtectedChatImageUrl(value) {
    if (!value || value.startsWith('data:') || value.startsWith('blob:')) return false;
    try {
      const url = new URL(value, location.href);
      const chatHost = url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com';
      return chatHost && (
        url.pathname.includes('/backend-api/estuary/content') ||
        url.pathname.includes('/backend-api/files/') ||
        url.pathname.includes('/backend-api/file/')
      );
    } catch {
      return false;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function canvasFallbackDataUrl(img) {
    if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  async function resolveProtectedImageSource(url, img) {
    if (state.imageCache.has(url)) return state.imageCache.get(url);

    const promise = (async () => {
      state.imageStats.protected += 1;
      try {
        const response = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const finalUrl = response.url || url;
        const contentType = response.headers.get('content-type') || '';
        const blob = await response.blob();
        const mime = blob.type || contentType;
        if (mime && !mime.toLowerCase().startsWith('image/')) {
          throw new Error(`Unexpected content type: ${mime}`);
        }

        // A redirect away from chatgpt.com is normally a signed CDN/blob URL that
        // Obsidian can fetch without the ChatGPT session cookie. Prefer that URL
        // so "Download attachments for current file" can create a normal file.
        let usePublicUrl = false;
        try {
          const final = new URL(finalUrl);
          usePublicUrl = finalUrl !== url &&
            final.protocol.startsWith('http') &&
            final.hostname !== 'chatgpt.com' &&
            final.hostname !== 'chat.openai.com';
        } catch {
          usePublicUrl = false;
        }

        if (usePublicUrl) {
          state.imageStats.public += 1;
          return { src: finalUrl, mode: 'public', mime: mime || 'image/*' };
        }

        const dataUrl = await blobToDataUrl(blob);
        state.imageStats.inline += 1;
        return { src: dataUrl, mode: 'inline', mime: mime || 'image/*' };
      } catch (error) {
        const fallback = await canvasFallbackDataUrl(img);
        if (fallback) {
          state.imageStats.inline += 1;
          return { src: fallback, mode: 'inline-canvas', mime: 'image/png' };
        }
        state.imageStats.failed += 1;
        console.warn('[ChatGPT Archive] Failed to preserve protected image', url, error);
        return { src: url, mode: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })();

    state.imageCache.set(url, promise);
    return promise;
  }

  async function prepareImages(section) {
    let unresolved = 0;
    const images = Array.from(section.querySelectorAll('img'));

    for (const img of images) {
      img.loading = 'eager';
      let raw = img.getAttribute('src') || img.currentSrc || '';
      if ((!raw || raw === 'data:,') && img.getAttribute('oldsrc')) {
        raw = img.getAttribute('oldsrc');
        img.setAttribute('src', raw);
      } else if ((!raw || raw === 'data:,') && img.getAttribute('data-src')) {
        raw = img.getAttribute('data-src');
        img.setAttribute('src', raw);
      }

      if (raw && isProtectedChatImageUrl(raw)) {
        const resolved = await resolveProtectedImageSource(raw, img);
        if (resolved?.src) {
          img.setAttribute('src', resolved.src);
          img.removeAttribute('srcset');
          img.removeAttribute('oldsrc');
          img.removeAttribute('data-src');
        }
        if (!resolved || resolved.mode === 'failed') unresolved += 1;
      } else if (!raw || raw === 'data:,') {
        unresolved += 1;
      }
    }

    return unresolved;
  }

  function normalizeUrlAttribute(el, name) {
    const value = el.getAttribute(name);
    if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('#')) return;
    try {
      el.setAttribute(name, new URL(value, location.href).href);
    } catch {
      // Keep the original value.
    }
  }

  function normalizeCodeBlocks(root) {
    for (const pre of root.querySelectorAll('pre')) {
      const sourceCode = pre.querySelector('code');
      if (!sourceCode) continue;

      const cleanCode = document.createElement('code');
      const lang = sourceCode.getAttribute('data-lang') ||
        Array.from(sourceCode.classList).find(c => c.startsWith('language-'))?.slice('language-'.length) || '';
      if (lang) {
        cleanCode.setAttribute('data-lang', lang);
        cleanCode.className = `language-${lang}`;
      }
      cleanCode.textContent = sourceCode.textContent || '';
      pre.replaceChildren(cleanCode);
    }
  }

  function removeUiNoise(root) {
    // ChatGPT citation pills contain tiny favicon images. They are UI chrome, not
    // conversation attachments, and they make Obsidian's attachment downloader
    // noisy. Removing only the icon preserves the citation anchor/text.
    root.querySelectorAll('[data-testid="webpage-citation-pill"] img, img[src*="google.com/s2/favicons"]').forEach(img => img.remove());

    // Preserve images wrapped by interactive buttons, remove the button shell.
    for (const button of Array.from(root.querySelectorAll('button'))) {
      if (button.querySelector('img')) {
        const fragment = document.createDocumentFragment();
        while (button.firstChild) fragment.appendChild(button.firstChild);
        button.replaceWith(fragment);
      } else {
        button.remove();
      }
    }

    const selectors = [
      'svg', 'form', 'textarea', 'input', 'select', 'option',
      '[role="group"]',
      '[data-conversation-preview-interactive]',
      '[data-testid$="-turn-action-button"]',
      '[data-testid="copy-turn-action-button"]'
    ];
    root.querySelectorAll(selectors.join(',')).forEach(el => el.remove());

    for (const img of root.querySelectorAll('img')) {
      const alt = (img.getAttribute('alt') || '').trim();
      const width = Number(img.getAttribute('width') || 0);
      const height = Number(img.getAttribute('height') || 0);
      const src = img.getAttribute('src') || '';
      const tiny = (width && width <= 48) || (height && height <= 48);
      if ((!alt && tiny) || !src || src === 'data:,') img.remove();
    }
  }

  function stripPresentationAttributes(root) {
    const allowed = new Set([
      'href', 'src', 'alt', 'title', 'width', 'height',
      'colspan', 'rowspan', 'start', 'reversed'
    ]);

    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!(el instanceof Element)) continue;
      if (el.tagName === 'A') normalizeUrlAttribute(el, 'href');
      if (el.tagName === 'IMG') normalizeUrlAttribute(el, 'src');

      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (allowed.has(name)) continue;
        if (el.tagName === 'CODE' && (name === 'class' || name === 'data-lang')) continue;
        el.removeAttribute(attr.name);
      }
    }
  }

  function cloneMessageContent(section) {
    const role = section.getAttribute('data-turn') || 'unknown';
    const candidates = Array.from(section.querySelectorAll('[data-message-author-role]'));
    const relevant = candidates.filter(node => node.getAttribute('data-message-author-role') === role);
    const sourceNodes = relevant.length ? relevant : [section];
    const fragment = document.createDocumentFragment();

    // Avoid cloning nested role containers twice if ChatGPT ever nests them.
    const topLevel = sourceNodes.filter(node => !sourceNodes.some(other => other !== node && other.contains(node)));

    for (const source of topLevel) {
      const clone = source.cloneNode(true);
      if (!(clone instanceof Element)) continue;
      removeUiNoise(clone);
      normalizeCodeBlocks(clone);
      stripPresentationAttributes(clone);
      fragment.appendChild(clone);
    }

    return { role, fragment };
  }

  function makeArchiveTurn(turnNumber, section) {
    const { role, fragment } = cloneMessageContent(section);

    if (role === 'user') {
      const quote = document.createElement('blockquote');
      quote.className = 'chatgpt-archive-turn chatgpt-archive-user';
      quote.dataset.turnNumber = String(turnNumber);

      const marker = document.createElement('p');
      marker.textContent = USER_CALLOUT_MARKER;
      quote.append(marker, fragment);
      return quote;
    }

    const wrapper = document.createElement('section');
    wrapper.className = 'chatgpt-archive-turn chatgpt-archive-assistant';
    wrapper.dataset.turnNumber = String(turnNumber);
    wrapper.appendChild(fragment);
    return wrapper;
  }

  function cloneQuality(node) {
    const text = (node.textContent || '').trim().length;
    const images = node.querySelectorAll ? node.querySelectorAll('img').length : 0;
    const tables = node.querySelectorAll ? node.querySelectorAll('table').length : 0;
    const code = node.querySelectorAll ? node.querySelectorAll('pre code').length : 0;
    return text + images * 5000 + tables * 1000 + code * 500;
  }

  async function harvestMountedTurns(thread, reason = '') {
    const sections = getMountedTurnSections(thread);

    for (const section of sections) {
      const turnNumber = parseTurnNumber(section);
      if (!turnNumber) continue;

      let unresolvedImage = await prepareImages(section);
      if (unresolvedImage) {
        await nextFrame();
        await sleep(80);
        unresolvedImage = await prepareImages(section);
      }

      const candidate = makeArchiveTurn(turnNumber, section);
      const existing = state.captured.get(turnNumber);
      if (!existing || cloneQuality(candidate) >= cloneQuality(existing)) {
        state.captured.set(turnNumber, candidate);
      }
    }

    refreshExpectedTotal(thread);
    const missing = getMissingTurnNumbers();
    const progress = `${state.captured.size}/${state.expectedTotal || '?'}`;
    setArchiveButton(`Capturing ${progress}`, true);
    setStatus(`取得中 ${progress}${reason ? ` — ${reason}` : ''}${missing.length ? ` — 未取得: ${missing.join(', ')}` : ''}`);
  }

  async function sweep(thread, scroller, direction, stepRatio, passName) {
    const pass = { name: passName, direction, stepRatio, startCaptured: state.captured.size, endCaptured: null };
    state.diagnostics.passes.push(pass);

    let viewport = Math.max(320, getViewportHeight(scroller));
    let step = Math.max(180, Math.floor(viewport * stepRatio));
    let max = getMaxScroll(scroller);
    let position = direction === 'down' ? 0 : max;
    let iterations = 0;
    const maxIterations = 10000;

    while (iterations++ < maxIterations) {
      await scrollAndSettle(scroller, position, 105);
      await harvestMountedTurns(thread, passName);
      if (isComplete()) break;

      viewport = Math.max(320, getViewportHeight(scroller));
      step = Math.max(180, Math.floor(viewport * stepRatio));
      max = getMaxScroll(scroller);

      if (direction === 'down') {
        if (position >= max - 2) break;
        position = Math.min(max, position + step);
      } else {
        if (position <= 2) break;
        position = Math.max(0, position - step);
      }
    }

    pass.endCaptured = state.captured.size;
  }

  async function traverseSlots(thread) {
    const slots = getUniqueTurnSlotElements(thread);
    const pass = { name: 'slot-recovery', slots: slots.length, startCaptured: state.captured.size, endCaptured: null };
    state.diagnostics.passes.push(pass);

    for (let i = 0; i < slots.length; i += 1) {
      if (isComplete()) break;
      const slot = slots[i];
      if (!slot.isConnected) continue;
      slot.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      await nextFrame();
      await sleep(135);
      await harvestMountedTurns(thread, `recovery ${i + 1}/${slots.length}`);
    }

    pass.endCaptured = state.captured.size;
  }

  async function captureConversation(thread) {
    state.captured.clear();
    state.expectedTotal = 0;
    state.imageCache.clear();
    state.imageStats = { protected: 0, public: 0, inline: 0, failed: 0 };
    state.diagnostics = {
      startedAt: new Date().toISOString(),
      initialSlotCount: getUniqueTurnSlotElements(thread).length,
      finalSlotCount: 0,
      initialMounted: getMountedTurnNumbers(thread),
      finalMounted: [],
      passes: [],
      missing: []
    };

    refreshExpectedTotal(thread);
    await harvestMountedTurns(thread, 'initial');

    const firstTurn = getMountedTurnSections(thread)[0] || thread;
    state.scrollContainer = findScrollContainer(firstTurn);
    rememberScrollPosition(state.scrollContainer);

    // Start at the very top and allow ChatGPT to load/materialize older turns.
    await scrollAndSettle(state.scrollContainer, 0, 650);
    await harvestMountedTurns(thread, 'top settle');

    await sweep(thread, state.scrollContainer, 'down', 0.55, 'down pass 1');

    if (!isComplete()) {
      await scrollAndSettle(state.scrollContainer, getMaxScroll(state.scrollContainer), 300);
      await harvestMountedTurns(thread, 'bottom settle');
      await sweep(thread, state.scrollContainer, 'up', 0.55, 'up pass 1');
    }

    if (!isComplete()) {
      await sweep(thread, state.scrollContainer, 'down', 0.30, 'down pass 2');
    }

    if (!isComplete()) {
      await traverseSlots(thread);
    }

    // One final harvest at the current location.
    await harvestMountedTurns(thread, 'final');

    state.diagnostics.finalSlotCount = getUniqueTurnSlotElements(thread).length;
    state.diagnostics.finalMounted = getMountedTurnNumbers(thread);
    state.diagnostics.missing = getMissingTurnNumbers();
  }

  function buildExportArticle() {
    const article = document.createElement('article');
    article.id = EXPORT_ID;
    article.setAttribute('data-chatgpt-archive-version', VERSION);
    article.setAttribute('data-chatgpt-archive-source', location.href);

    const expected = state.expectedTotal;
    for (let i = 1; i <= expected; i += 1) {
      const turn = state.captured.get(i);
      if (!turn) continue;
      article.appendChild(turn.cloneNode(true));
    }

    return article;
  }

  function buildInterpreterContext() {
    const chunks = [];
    for (let i = 1; i <= state.expectedTotal; i += 1) {
      const turn = state.captured.get(i);
      if (!turn) continue;
      const clone = turn.cloneNode(true);
      if (!(clone instanceof Element)) continue;

      for (const img of clone.querySelectorAll('img')) {
        const alt = (img.getAttribute('alt') || 'image').trim();
        img.replaceWith(document.createTextNode(`[Image: ${alt}]`));
      }

      let text = (clone.textContent || '').replaceAll(USER_CALLOUT_MARKER, '').trim();
      if (!text) continue;
      const role = turn.classList.contains('chatgpt-archive-user') ? 'User' : 'ChatGPT';
      chunks.push(`${role}:\n${text}`);
    }
    return chunks.join('\n\n---\n\n');
  }

  function installInterpreterContextMeta() {
    const existing = document.head.querySelector(`meta[name="${AI_CONTEXT_META_NAME}"]`);
    state.originalContextMeta = existing
      ? { existed: true, content: existing.getAttribute('content') || '' }
      : { existed: false, content: '' };

    const meta = existing || document.createElement('meta');
    meta.setAttribute('name', AI_CONTEXT_META_NAME);
    meta.setAttribute('content', buildInterpreterContext());
    if (!existing) document.head.appendChild(meta);
  }

  function restoreInterpreterContextMeta() {
    const meta = document.head.querySelector(`meta[name="${AI_CONTEXT_META_NAME}"]`);
    if (!state.originalContextMeta) {
      meta?.remove();
      return;
    }
    if (state.originalContextMeta.existed) {
      if (meta) meta.setAttribute('content', state.originalContextMeta.content);
    } else {
      meta?.remove();
    }
    state.originalContextMeta = null;
  }

  function enterArchiveMode(article) {
    const main = getMainElement();
    if (!main) throw new Error('ChatGPT の main 要素を見つけられませんでした。');

    state.main = main;
    state.originalMainNodes = Array.from(main.childNodes);
    installInterpreterContextMeta();
    main.replaceChildren(article);
    document.documentElement.dataset.chatgptObsidianArchiveMode = 'true';
    state.archiveMode = true;

    window.scrollTo({ top: 0, behavior: 'auto' });
    setArchiveButton('Restore ChatGPT');
    setDiagnosticsVisible(true);

    const missing = getMissingTurnNumbers();
    const imageSummary = `画像: protected ${state.imageStats.protected} / public ${state.imageStats.public} / inline ${state.imageStats.inline} / failed ${state.imageStats.failed}`;
    if (missing.length) {
      setStatus(`準備未完了 ${state.captured.size}/${state.expectedTotal}。未取得 turn: ${missing.join(', ')}。${imageSummary}。Web Clipper で保存せず、Copy diagnostics の内容を送ってください。`);
    } else {
      const imageWarning = state.imageStats.failed ? ' 一部の保護画像を自己完結化できませんでした。Copy diagnostics を保存してください。' : '';
      setStatus(`準備完了 ${state.captured.size}/${state.expectedTotal}（turn 1–${state.expectedTotal} 連続）。${imageSummary}。この状態で Obsidian Web Clipper を開いてください。${imageWarning}`);
    }
  }

  function restoreMainWithoutReload() {
    if (!state.main || !state.originalMainNodes.length || !state.main.isConnected) return false;
    try {
      state.main.replaceChildren(...state.originalMainNodes);
      return true;
    } catch {
      return false;
    }
  }

  function exitArchiveMode() {
    delete document.documentElement.dataset.chatgptObsidianArchiveMode;
    state.archiveMode = false;

    const restored = restoreMainWithoutReload();
    restoreInterpreterContextMeta();
    state.originalMainNodes = [];
    state.main = null;
    setDiagnosticsVisible(false);
    setArchiveButton('ChatGPT Archive');
    setStatus('', false);

    if (restored) {
      requestAnimationFrame(() => restoreScrollPosition());
    } else {
      location.reload();
    }
  }

  function diagnosticsPayload() {
    return {
      extensionVersion: VERSION,
      url: location.href,
      readerActive: isObsidianReaderActive(),
      expectedTotal: state.expectedTotal,
      capturedTurnNumbers: Array.from(state.captured.keys()).sort((a, b) => a - b),
      missingTurnNumbers: getMissingTurnNumbers(),
      imageStats: state.imageStats,
      protectedImageResults: Array.from(state.imageCache.entries()).map(([url, value]) => ({ url, result: 'Promise (see imageStats)' })),
      diagnostics: state.diagnostics
    };
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(diagnosticsPayload(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('診断情報をクリップボードへコピーしました。');
    } catch (error) {
      console.info('[ChatGPT Archive diagnostics]', text);
      setStatus('クリップボードへのコピーに失敗しました。DevTools Console に診断情報を出力しました。');
    }
  }

  async function prepareArchive() {
    if (state.busy) return;

    if (isObsidianReaderActive()) {
      setStatus('先に Obsidian Web Clipper の Reader View を閉じて、通常の ChatGPT 画面で ChatGPT Archive を実行してください。');
      return;
    }

    const thread = getConversationThread();
    if (!thread) {
      setStatus('ChatGPT の会話 thread を検出できませんでした。ページを再読み込みしてからお試しください。');
      return;
    }

    state.busy = true;
    setDiagnosticsVisible(false);
    setArchiveButton('Capturing…', true);
    setStatus('会話を走査しています。画面が自動でスクロールします。');

    try {
      await captureConversation(thread);
      const article = buildExportArticle();
      enterArchiveMode(article);
    } catch (error) {
      console.error('[ChatGPT Archive]', error);
      setStatus(`エラー: ${error instanceof Error ? error.message : String(error)}`);
      setArchiveButton('Retry ChatGPT Archive');
      setDiagnosticsVisible(true);
      restoreScrollPosition();
    } finally {
      state.busy = false;
      const button = document.getElementById(ARCHIVE_BUTTON_ID);
      if (button) button.disabled = false;
    }
  }

  async function onArchiveButtonClick() {
    if (state.busy) return;
    if (state.archiveMode) {
      exitArchiveMode();
      return;
    }
    await prepareArchive();
  }

  function onRouteMaybeChanged() {
    if (state.routeKey !== location.href) {
      state.routeKey = location.href;
      if (state.archiveMode) {
        // A route transition while archive mode is active is safest to recover via reload.
        location.reload();
        return;
      }
      state.captured.clear();
      state.expectedTotal = 0;
      setDiagnosticsVisible(false);
      setStatus('', false);
      setArchiveButton('ChatGPT Archive');
    }
    ensureControls();
  }

  ensureControls();
  setInterval(onRouteMaybeChanged, 1000);
})();
