// Resurface — Content Script
// Intercepts bookmark actions on X/Twitter and injects resurface recall cards

(function () {
  'use strict';

  const RESURFACE_INJECTED_ATTR = 'data-resurface-injected';
  const GHOST_CARD_CLASS = 'resurface-ghost-card';
  let tweetsSinceLastInject = 0;
  let injectFrequency = 5;
  let ghostEnabled = true;
  let observerActive = false;
  let processedTweets = new Set();

  // Load settings
  chrome.runtime.sendMessage({ type: 'DEWEY_GET_SETTINGS' }, (response) => {
    if (response && response.settings) {
      injectFrequency = response.settings.injectFrequency || 5;
      ghostEnabled = response.settings.ghostEnabled !== false;
    }
  });

  // ─── BOOKMARK DETECTION ─────────────────────────────────────────
  // Watch for bookmark button clicks on X/Twitter
  function setupBookmarkDetection() {
    document.addEventListener('click', handleClick, true);
  }

  function handleClick(event) {
    const target = event.target.closest('[data-testid="bookmark"], [data-testid="removeBookmark"]');
    if (!target) return;

    const isBookmarking = target.getAttribute('data-testid') === 'bookmark';
    if (!isBookmarking) return;

    // Find the parent tweet article
    const article = target.closest('article[data-testid="tweet"]');
    if (!article) return;

    const tweetData = extractTweetData(article);
    if (tweetData) {
      chrome.runtime.sendMessage({
        type: 'DEWEY_SAVE_BOOKMARK',
        payload: tweetData,
      });
      showSavedAnimation(target);
    }
  }

  function extractTweetData(article) {
    try {
      // Extract tweet URL
      const timeEl = article.querySelector('time');
      const linkEl = timeEl ? timeEl.closest('a') : null;
      const tweetUrl = linkEl ? linkEl.href : window.location.href;
      const tweetId = tweetUrl.match(/status\/(\d+)/)?.[1] || `${Date.now()}`;

      // Extract author info
      const authorEl = article.querySelector('[data-testid="User-Name"]');
      let author = '';
      let authorHandle = '';
      if (authorEl) {
        const spans = authorEl.querySelectorAll('span');
        for (const span of spans) {
          const text = span.textContent.trim();
          if (text.startsWith('@')) {
            authorHandle = text;
          } else if (text && !author && text !== '·' && !text.match(/^\d/)) {
            author = text;
          }
        }
      }

      // Extract avatar
      const avatarEl = article.querySelector('[data-testid="Tweet-User-Avatar"] img');
      const authorAvatar = avatarEl ? avatarEl.src : '';

      // Extract tweet text
      const textEl = article.querySelector('[data-testid="tweetText"]');
      let text = textEl ? textEl.textContent.trim() : '';

      // If tweet has no body text, try to extract the article/link card preview
      if (!text) {
        const cardWrapper = article.querySelector('[data-testid="card.wrapper"]');
        if (cardWrapper) {
          // Article title lives in a span inside the card
          const cardTitle = cardWrapper.querySelector('[data-testid="card.layoutLarge.title"], [data-testid="card.layoutSmall.title"]');
          const cardDesc  = cardWrapper.querySelector('[data-testid="card.layoutLarge.detail"], [data-testid="card.layoutSmall.detail"]');
          const titleText = cardTitle ? cardTitle.textContent.trim() : '';
          const descText  = cardDesc  ? cardDesc.textContent.trim()  : '';
          text = [titleText, descText].filter(Boolean).join(' — ');
        }
      }

      // Extract timestamp
      const timestamp = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();

      return { tweetId, url: tweetUrl, text, author, authorHandle, authorAvatar, timestamp };
    } catch (e) {
      console.warn('[Resurface] Failed to extract tweet data:', e);
      return null;
    }
  }

  function showSavedAnimation(buttonEl) {
    const toast = document.createElement('div');
    toast.className = 'resurface-save-toast';
    toast.innerHTML = `
      <span class="resurface-toast-dot"></span>
      <span>Saved to Resurface</span>
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 400);
    }, 2000);
  }

  // ─── GHOST CARD INJECTION ──────────────────────────────────────
  // Periodically inject forgotten bookmarks into the timeline
  function setupGhostInjection() {
    if (!ghostEnabled) return;

    // Use Intersection Observer to track tweets scrolling by
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const article = entry.target;
          const id = article.querySelector('time')?.closest('a')?.href || '';
          if (id && !processedTweets.has(id)) {
            processedTweets.add(id);
            tweetsSinceLastInject++;

            if (tweetsSinceLastInject >= injectFrequency) {
              tweetsSinceLastInject = 0;
              injectGhostCard(article);
            }
          }
        }
      });
    }, { threshold: 0.5 });

    // Observe tweet articles as they appear
    const timelineObserver = new MutationObserver(() => {
      const articles = document.querySelectorAll(`article[data-testid="tweet"]:not([${RESURFACE_INJECTED_ATTR}])`);
      articles.forEach(article => {
        article.setAttribute(RESURFACE_INJECTED_ATTR, 'true');
        observer.observe(article);
      });
    });

    // Start observing
    const startObserving = () => {
      const timeline = document.querySelector('[data-testid="primaryColumn"]') || document.body;
      timelineObserver.observe(timeline, { childList: true, subtree: true });
      observerActive = true;
    };

    if (document.readyState === 'complete') {
      startObserving();
    } else {
      window.addEventListener('load', startObserving);
    }
  }

  async function injectGhostCard(afterArticle) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'DEWEY_GET_RECALL', mode: 'spaced' });
      if (!response || !response.bookmark) return;

      const bookmark = response.bookmark;
      const card = createGhostCard(bookmark);

      // Insert inside the cellInnerDiv, after the tweet article.
      const parent = afterArticle.closest('[data-testid="cellInnerDiv"]');
      if (parent) {
        parent.appendChild(card);
      }
    } catch (e) {
      // Extension context might be invalidated
      console.warn('[Resurface] Ghost injection failed:', e);
    }
  }

  function createGhostCard(bookmark) {
    const wrapper = document.createElement('div');
    wrapper.className = GHOST_CARD_CLASS;
    wrapper.setAttribute('data-resurface-bookmark-id', bookmark.id);

    const ageMs = Date.now() - bookmark.savedAt;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const ageText = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`;

    wrapper.innerHTML = `
      <div class="resurface-ghost-inner">
        <div class="resurface-ghost-header">
          <div class="resurface-ghost-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="17 11 12 6 7 11"/>
              <polyline points="17 18 12 13 7 18"/>
            </svg>
          </div>
          <div class="resurface-ghost-label">
            <span class="resurface-ghost-tag">Resurface</span>
            <span class="resurface-ghost-age">saved ${ageText}</span>
          </div>
        </div>
        <div class="resurface-ghost-body">
          ${bookmark.authorAvatar ? `<img class="resurface-ghost-avatar" src="${bookmark.authorAvatar}" alt="" />` : ''}
          <div class="resurface-ghost-content">
            <div class="resurface-ghost-author">
              <strong>${escapeHtml(bookmark.author || 'Unknown')}</strong>
              <span class="resurface-ghost-handle">${escapeHtml(bookmark.authorHandle || '')}</span>
            </div>
            <p class="resurface-ghost-text">${escapeHtml(bookmark.text || 'No preview available')}</p>
          </div>
        </div>
        <div class="resurface-ghost-actions">
          <a href="${bookmark.url}" class="resurface-ghost-btn resurface-ghost-btn-primary" target="_self">
            View post
          </a>
          <button class="resurface-ghost-btn resurface-ghost-btn-secondary resurface-mark-recalled" data-id="${bookmark.id}">
            Mark as read
          </button>
        </div>
      </div>
    `;

    // Event listeners

    wrapper.querySelector('.resurface-mark-recalled').addEventListener('click', (e) => {
      e.stopPropagation();
      const id = e.currentTarget.dataset.id;
      chrome.runtime.sendMessage({ type: 'DEWEY_MARK_RECALLED', id });
      wrapper.classList.add('resurface-ghost-recalled');
      setTimeout(() => wrapper.remove(), 600);
    });

    const viewBtn = wrapper.querySelector('.resurface-ghost-btn-primary');
    viewBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'DEWEY_MARK_RECALLED', id: bookmark.id });
    });

    return wrapper;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── INIT ──────────────────────────────────────────────────────
  setupBookmarkDetection();
  setupGhostInjection();
})();
