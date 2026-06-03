document.addEventListener('DOMContentLoaded', async () => {
  // ─── State ──────────────────────────────────────────────────
  let bookmarks = [];
  let stats = null;
  let settings = null;
  let currentFilter = 'all';
  let onboardingDone = false;

  // ─── DOM ────────────────────────────────────────────────────
  const tabs         = document.querySelectorAll('.nav-tab');
  const tabContents  = document.querySelectorAll('.tab-content');

  // Home
  const onboarding   = document.getElementById('onboarding');
  const recallView   = document.getElementById('recall-view');
  const elTotal      = document.getElementById('stat-total');
  const elUnrecalled = document.getElementById('stat-unrecalled');
  const elStreak     = document.getElementById('stat-streak');
  const recallCard   = document.getElementById('recall-card');
  const recallBtn    = document.getElementById('recall-btn');

  // Library
  const bookmarksList = document.getElementById('bookmarks-list');
  const searchInput   = document.getElementById('search-input');
  const filterBtns    = document.querySelectorAll('.filter-btn');

  // Settings drawer
  const settingsBtn     = document.getElementById('settings-btn');
  const settingsClose   = document.getElementById('settings-close');
  const settingsDrawer  = document.getElementById('settings-drawer');
  const settingsOverlay = document.getElementById('settings-overlay');
  const ghostToggle     = document.getElementById('setting-ghost');
  const freqValue       = document.getElementById('setting-frequency');
  const freqDisplay     = document.getElementById('freq-display');
  const freqBtns        = document.querySelectorAll('.stepper-btn');
  const notifToggle     = document.getElementById('setting-notifications');
  const modeOptions     = document.querySelectorAll('.mode-option');
  const clearBtn        = document.getElementById('clear-all-btn');

  // ─── Init ───────────────────────────────────────────────────
  try { await loadData(); } catch (e) { console.warn('[Resurface] loadData error:', e); }
  setupEventListeners();
  renderAll();

  // ─── Data Loading ───────────────────────────────────────────
  async function loadData() {
    bookmarks = await msg('DEWEY_GET_ALL_BOOKMARKS', null, r => (r && r.bookmarks) || []);
    stats     = await msg('DEWEY_GET_STATS',         null, r => (r && r.stats)     || {});
    settings  = await msg('DEWEY_GET_SETTINGS',      null, r => (r && r.settings)  || {});

    // Persist onboarding-done flag so clearing bookmarks never shows it again
    const stored = await new Promise(r => chrome.storage.local.get('dewey_onboarding_done', r));
    onboardingDone = !!stored.dewey_onboarding_done;

    if (bookmarks.length > 0 && !onboardingDone) {
      onboardingDone = true;
      chrome.storage.local.set({ dewey_onboarding_done: true });
    }
  }

  function msg(type, extra = {}, pick = r => r) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, ...extra }, r => {
          // r can be undefined if service worker isn't running yet
          if (chrome.runtime.lastError) {
            console.warn('[Resurface]', chrome.runtime.lastError.message);
            resolve(pick(undefined));
            return;
          }
          try { resolve(pick(r)); }
          catch (e) { resolve(pick(undefined)); }
        });
      } catch (e) {
        console.warn('[Resurface] sendMessage failed:', e);
        resolve(pick(undefined));
      }
    });
  }

  // ─── Render ─────────────────────────────────────────────────
  function renderAll() {
    const hasBookmarks  = bookmarks.length > 0;
    const showOnboarding = !onboardingDone && !hasBookmarks;
    onboarding.style.display = showOnboarding ? 'block' : 'none';
    recallView.style.display = showOnboarding ? 'none'  : 'flex';

    if (!showOnboarding) {
      renderStats();
      updateRecallBtn();
    }
    renderBookmarks();
    renderSettings();
  }

  function renderStats() {
    elTotal.textContent      = stats.totalBookmarks || 0;
    elUnrecalled.textContent = stats.unrecalled     || 0;
    elStreak.textContent     = stats.streakDays     || 0;
  }



  function updateRecallBtn() {
    const unread = bookmarks.filter(b => !b.recalled).length;
    recallBtn.disabled = unread === 0;
  }

  // ─── Recall ─────────────────────────────────────────────────
  async function performRecall() {
    recallBtn.disabled = true;
    recallCard.innerHTML = `<div class="recall-empty-state"><p style="color:var(--text-3)">Resurfacing…</p></div>`;
    await new Promise(r => setTimeout(r, 500));

    const mode = settings.recallMode || 'spaced';
    const res  = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'DEWEY_GET_RECALL', mode }, r)
    );

    if (res && res.bookmark) {
      renderRecallCard(res.bookmark);
    } else {
      recallCard.innerHTML = `<div class="recall-empty-state"><div class="recall-up-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><p>All caught up!</p></div>`;
    }
    updateRecallBtn();
  }

  function renderRecallCard(b) {
    recallCard.innerHTML = `
      <div style="animation:fadeUp 0.35s ease">
        <div class="recall-item-author">
          ${b.authorAvatar ? `<img class="recall-item-avatar" src="${b.authorAvatar}" alt="">` : ''}
          <div>
            <div class="recall-item-name">${esc(b.author || 'Unknown')}</div>
            <div class="recall-item-handle">${esc(b.authorHandle || '')}</div>
          </div>
        </div>
        <div class="recall-item-text">${esc(b.text || 'No preview available')}</div>
        <div class="recall-item-actions">
          <a href="${b.url}" target="_blank" class="recall-item-btn btn-primary" id="recall-visit">Visit &amp; Mark Read</a>
        </div>
      </div>
    `;
    document.getElementById('recall-visit').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'DEWEY_MARK_RECALLED', id: b.id });
      setTimeout(() => {
        recallCard.innerHTML = `<div class="recall-empty-state"><div class="recall-up-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/></svg></div><p>Ready for another?</p></div>`;
        loadData().then(renderAll);
      }, 600);
    });
  }

  // ─── Bookmarks List ─────────────────────────────────────────
  function renderBookmarks() {
    let list = [...bookmarks];
    if (currentFilter === 'unread') list = list.filter(b => !b.recalled);
    if (currentFilter === 'read')   list = list.filter(b =>  b.recalled);

    const q = searchInput.value.toLowerCase();
    if (q) {
      list = list.filter(b =>
        (b.text         && b.text.toLowerCase().includes(q)) ||
        (b.author       && b.author.toLowerCase().includes(q)) ||
        (b.authorHandle && b.authorHandle.toLowerCase().includes(q))
      );
    }

    list.sort((a, b) => b.savedAt - a.savedAt);
    bookmarksList.innerHTML = '';

    if (!list.length) {
      bookmarksList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></div>
          <p>${bookmarks.length === 0 ? 'No bookmarks yet' : 'No matching bookmarks'}</p>
          ${bookmarks.length === 0 ? '<p class="empty-hint">Bookmark posts on X to get started</p>' : ''}
        </div>`;
      return;
    }

    list.forEach(b => {
      const el   = document.createElement('div');
      el.className = `bookmark-item ${!b.recalled ? 'unread' : ''}`;
      const date = new Date(b.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

      el.innerHTML = `
        <div class="bookmark-date">
          <span>Saved ${date}</span>
          ${!b.recalled ? '<span class="bookmark-badge">Unread</span>' : ''}
        </div>
        <div class="recall-item-author">
          ${b.authorAvatar ? `<img class="recall-item-avatar" src="${b.authorAvatar}" alt="">` : ''}
          <div>
            <div class="recall-item-name">${esc(b.author || 'Unknown')}</div>
            <div class="recall-item-handle">${esc(b.authorHandle || '')}</div>
          </div>
        </div>
        <div class="recall-item-text">${esc(b.text || 'No preview available')}</div>
        <div class="recall-item-actions">
          <a href="${b.url}" target="_blank" class="recall-item-btn btn-primary btn-visit" data-id="${b.id}">View Tweet</a>
          <button class="recall-item-btn btn-secondary btn-delete" data-id="${b.id}">Delete</button>
        </div>
      `;
      bookmarksList.appendChild(el);
    });

    bookmarksList.querySelectorAll('.btn-visit').forEach(btn =>
      btn.addEventListener('click', () =>
        chrome.runtime.sendMessage({ type: 'DEWEY_MARK_RECALLED', id: btn.dataset.id })
      )
    );

    bookmarksList.querySelectorAll('.btn-delete').forEach(btn =>
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'DEWEY_DELETE_BOOKMARK', id: btn.dataset.id });
        await loadData();
        renderAll();
      })
    );
  }

  // ─── Settings ───────────────────────────────────────────────
  function renderSettings() {
    ghostToggle.checked  = settings.ghostEnabled !== false;
    const freq = settings.injectFrequency || 5;
    freqValue.textContent   = freq;
    if (freqDisplay) freqDisplay.textContent = freq;
    notifToggle.checked  = settings.notificationsEnabled !== false;

    const mode = settings.recallMode || 'spaced';
    modeOptions.forEach(opt => {
      const isActive = opt.dataset.mode === mode;
      opt.classList.toggle('active', isActive);
      opt.querySelector('input').checked = isActive;
    });
  }

  async function saveSettings(updates) {
    settings = { ...settings, ...updates };
    await chrome.runtime.sendMessage({ type: 'DEWEY_SAVE_SETTINGS', settings });
    renderSettings();
  }

  // ─── Settings Drawer ────────────────────────────────────────
  function openSettings() {
    settingsDrawer.classList.add('open');
    settingsOverlay.classList.add('open');
  }
  function closeSettings() {
    settingsDrawer.classList.remove('open');
    settingsOverlay.classList.remove('open');
  }

  // ─── Event Listeners ────────────────────────────────────────
  function setupEventListeners() {
    // Tab switching
    tabs.forEach(tab =>
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      })
    );

    // Recall
    recallBtn.addEventListener('click', performRecall);

    // Library filters
    filterBtns.forEach(btn =>
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderBookmarks();
      })
    );
    searchInput.addEventListener('input', renderBookmarks);

    // Settings drawer
    settingsBtn.addEventListener('click', openSettings);
    settingsClose.addEventListener('click', closeSettings);
    settingsOverlay.addEventListener('click', closeSettings);

    // Settings controls
    ghostToggle.addEventListener('change',  e => saveSettings({ ghostEnabled: e.target.checked }));
    notifToggle.addEventListener('change',  e => saveSettings({ notificationsEnabled: e.target.checked }));

    freqBtns.forEach(btn =>
      btn.addEventListener('click', () => {
        let val = parseInt(freqValue.textContent, 10);
        val = btn.dataset.action === 'increase'
          ? Math.min(val + 1, 50)
          : Math.max(val - 1, 1);
        saveSettings({ injectFrequency: val });
      })
    );

    modeOptions.forEach(opt =>
      opt.addEventListener('click', () => saveSettings({ recallMode: opt.dataset.mode }))
    );

    clearBtn.addEventListener('click', async () => {
      if (!confirm('Delete ALL saved bookmarks? This cannot be undone.')) return;
      for (const b of bookmarks) {
        await chrome.runtime.sendMessage({ type: 'DEWEY_DELETE_BOOKMARK', id: b.id });
      }
      await loadData();
      renderAll();
      closeSettings();
    });
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
});
