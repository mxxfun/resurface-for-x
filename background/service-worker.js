// Dewey — Background Service Worker
// Handles alarms, notifications, and bookmark management

const STORAGE_KEY = 'dewey_bookmarks';
const SETTINGS_KEY = 'dewey_settings';
const STATS_KEY = 'dewey_stats';

const DEFAULT_SETTINGS = {
  injectFrequency: 5,       // inject a ghost card every N tweets scrolled past
  notificationsEnabled: true,
  notificationInterval: 120, // minutes between notifications
  ghostEnabled: true,
  recallMode: 'spaced',     // 'spaced' | 'random' | 'oldest'
};

// Initialize on install
chrome.runtime.onInstalled.addListener(async () => {
  const { [SETTINGS_KEY]: existing } = await chrome.storage.local.get(SETTINGS_KEY);
  if (!existing) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
  await ensureStats();
  setupAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarms();
});

// Setup periodic alarms
function setupAlarms() {
  chrome.alarms.create('dewey-recall', { periodInMinutes: 120 });
  chrome.alarms.create('dewey-daily-digest', { periodInMinutes: 1440 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dewey-recall') {
    const settings = await getSettings();
    if (settings.notificationsEnabled) {
      await sendRecallNotification();
    }
  }
  if (alarm.name === 'dewey-daily-digest') {
    await sendDigestNotification();
  }
});

// Send a recall notification with a random forgotten bookmark
async function sendRecallNotification() {
  const bookmark = await getRandomUnvisitedBookmark();
  if (!bookmark) return;

  chrome.notifications.create(`dewey-recall-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: '👻 A forgotten bookmark wants attention',
    message: bookmark.text ? bookmark.text.substring(0, 100) + '...' : 'You bookmarked something and forgot about it!',
    priority: 1,
  });
}

async function sendDigestNotification() {
  const { [STORAGE_KEY]: bookmarks = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const unvisited = bookmarks.filter(b => !b.recalled);
  if (unvisited.length === 0) return;

  chrome.notifications.create(`dewey-digest-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `📚 You have ${unvisited.length} unread bookmark${unvisited.length > 1 ? 's' : ''}`,
    message: `Don't let them gather dust! Click to revisit.`,
    priority: 1,
  });
}

// Handle notification clicks
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith('dewey-recall')) {
    const bookmark = await getRandomUnvisitedBookmark();
    if (bookmark && bookmark.url) {
      chrome.tabs.create({ url: bookmark.url });
      await markAsRecalled(bookmark.id);
    }
  }
});

// Message handler for content script communication
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEWEY_SAVE_BOOKMARK') {
    saveBookmark(message.payload).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'DEWEY_GET_RECALL') {
    getRecallBookmark(message.mode).then(bookmark => sendResponse({ bookmark }));
    return true;
  }

  if (message.type === 'DEWEY_MARK_RECALLED') {
    markAsRecalled(message.id).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'DEWEY_GET_STATS') {
    getStats().then(stats => sendResponse({ stats }));
    return true;
  }

  if (message.type === 'DEWEY_GET_ALL_BOOKMARKS') {
    getAllBookmarks().then(bookmarks => sendResponse({ bookmarks }));
    return true;
  }

  if (message.type === 'DEWEY_DELETE_BOOKMARK') {
    deleteBookmark(message.id).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'DEWEY_GET_SETTINGS') {
    getSettings().then(settings => sendResponse({ settings }));
    return true;
  }

  if (message.type === 'DEWEY_SAVE_SETTINGS') {
    chrome.storage.local.set({ [SETTINGS_KEY]: message.settings }).then(() => sendResponse({ success: true }));
    return true;
  }
});

// Bookmark CRUD operations
async function saveBookmark(data) {
  const { [STORAGE_KEY]: bookmarks = [] } = await chrome.storage.local.get(STORAGE_KEY);

  // Check for duplicate
  if (bookmarks.some(b => b.tweetId === data.tweetId)) return;

  const bookmark = {
    id: crypto.randomUUID(),
    tweetId: data.tweetId,
    url: data.url,
    text: data.text,
    author: data.author,
    authorHandle: data.authorHandle,
    authorAvatar: data.authorAvatar,
    timestamp: data.timestamp,
    savedAt: Date.now(),
    recalled: false,
    recalledAt: null,
    recallCount: 0,
    nextRecallAt: Date.now() + (24 * 60 * 60 * 1000), // first recall after 1 day
    interval: 1,
  };

  bookmarks.push(bookmark);
  await chrome.storage.local.set({ [STORAGE_KEY]: bookmarks });
  await updateStats('saved');
}

async function deleteBookmark(id) {
  const { [STORAGE_KEY]: bookmarks = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const filtered = bookmarks.filter(b => b.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
}

async function markAsRecalled(id) {
  const { [STORAGE_KEY]: bookmarks = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const bookmark = bookmarks.find(b => b.id === id);
  if (bookmark) {
    bookmark.recalled = true;
    bookmark.recalledAt = Date.now();
    bookmark.recallCount += 1;
    // Spaced repetition: double the interval each time
    bookmark.interval = Math.min(bookmark.interval * 2, 30);
    bookmark.nextRecallAt = Date.now() + (bookmark.interval * 24 * 60 * 60 * 1000);
    await chrome.storage.local.set({ [STORAGE_KEY]: bookmarks });
    await updateStats('recalled');
  }
}

async function getRandomUnvisitedBookmark() {
  const { [STORAGE_KEY]: bookmarks = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const unvisited = bookmarks.filter(b => !b.recalled);
  if (unvisited.length === 0) return null;
  return unvisited[Math.floor(Math.random() * unvisited.length)];
}

async function getRecallBookmark(mode = 'spaced') {
  const { [STORAGE_KEY]: bookmarks = [] } = await chrome.storage.local.get(STORAGE_KEY);
  if (bookmarks.length === 0) return null;

  const now = Date.now();

  switch (mode) {
    case 'spaced': {
      // Only consider bookmarks not permanently dismissed:
      // - never recalled yet, OR due for a spaced-repetition re-review
      const candidates = bookmarks.filter(b => !b.recalled || now >= b.nextRecallAt);
      if (candidates.length === 0) return null;

      // Prefer bookmarks whose next recall time has already passed
      const due = candidates.filter(b => now >= b.nextRecallAt);
      if (due.length > 0) {
        // Sort by oldest nextRecallAt first (most overdue first)
        due.sort((a, b) => a.nextRecallAt - b.nextRecallAt);
        return due[0];
      }
      // Fallback: most forgotten (never recalled, oldest saved)
      const unrecalled = candidates.filter(b => b.recallCount === 0);
      if (unrecalled.length > 0) {
        unrecalled.sort((a, b) => a.savedAt - b.savedAt);
        return unrecalled[0];
      }
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    case 'oldest': {
      const sorted = [...bookmarks].sort((a, b) => a.savedAt - b.savedAt);
      return sorted.find(b => !b.recalled) || null;
    }
    case 'random':
    default: {
      const eligible = bookmarks.filter(b => !b.recalled);
      if (eligible.length === 0) return null;
      return eligible[Math.floor(Math.random() * eligible.length)];
    }
  }
}

async function getAllBookmarks() {
  const { [STORAGE_KEY]: bookmarks = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return bookmarks;
}

async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return settings || DEFAULT_SETTINGS;
}

// Stats tracking
async function ensureStats() {
  const { [STATS_KEY]: existing } = await chrome.storage.local.get(STATS_KEY);
  if (!existing) {
    await chrome.storage.local.set({
      [STATS_KEY]: {
        totalSaved: 0,
        totalRecalled: 0,
        streakDays: 0,
        lastRecallDate: null,
        savedByDay: {},
        recalledByDay: {},
      }
    });
  }
}

async function updateStats(action) {
  const { [STATS_KEY]: stats } = await chrome.storage.local.get(STATS_KEY);
  if (!stats) return;

  const today = new Date().toISOString().split('T')[0];

  if (action === 'saved') {
    stats.totalSaved += 1;
    stats.savedByDay[today] = (stats.savedByDay[today] || 0) + 1;
  }

  if (action === 'recalled') {
    stats.totalRecalled += 1;
    stats.recalledByDay[today] = (stats.recalledByDay[today] || 0) + 1;

    // Update streak
    if (stats.lastRecallDate) {
      const lastDate = new Date(stats.lastRecallDate);
      const todayDate = new Date(today);
      const diffDays = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        stats.streakDays += 1;
      } else if (diffDays > 1) {
        stats.streakDays = 1;
      }
    } else {
      stats.streakDays = 1;
    }
    stats.lastRecallDate = today;
  }

  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

async function getStats() {
  const { [STATS_KEY]: stats } = await chrome.storage.local.get(STATS_KEY);
  const { [STORAGE_KEY]: bookmarks = [] } = await chrome.storage.local.get(STORAGE_KEY);

  const now = Date.now();
  const unrecalled = bookmarks.filter(b => b.recallCount === 0).length;
  const avgAge = bookmarks.length > 0
    ? bookmarks.reduce((sum, b) => sum + (now - b.savedAt), 0) / bookmarks.length
    : 0;

  return {
    ...stats,
    totalBookmarks: bookmarks.length,
    unrecalled,
    avgAgeDays: Math.floor(avgAge / (1000 * 60 * 60 * 24)),
  };
}
