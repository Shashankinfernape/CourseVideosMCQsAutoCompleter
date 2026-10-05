const statusNode = document.getElementById('status');
const statusCard = document.getElementById('status-card');
const helperToggle = document.getElementById('helper-toggle');
const labsToggle = document.getElementById('labs-toggle');
const videosToggle = document.getElementById('videos-toggle');

const settings = {
  courseHelperEnabled: false,
  autoSkipLabs: true,
  autoSkipVideos: true
};

function showStatus(value) {
  statusNode.textContent = value;
  const text = String(value).toLowerCase();
  statusCard.dataset.state = /failed|could not|not found|stopped without|below .* passing|error/.test(text)
    ? 'error'
    : /score report|selected \d+ answers|prompt sent|successfully/.test(text)
      ? 'success'
      : /monitor|scanning|quiz found|skipping|waiting|submitting|retaking|opening|active/.test(text)
        ? 'working'
        : 'neutral';
}

function renderToggles() {
  helperToggle.setAttribute('aria-checked', String(settings.courseHelperEnabled));
  labsToggle.setAttribute('aria-checked', String(settings.autoSkipLabs));
  videosToggle.setAttribute('aria-checked', String(settings.autoSkipVideos));
}

async function getTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab was found.');
  return tab;
}

async function inject(tab) {
  await browser.tabs.executeScript(tab.id, { file: 'content.js', allFrames: true });
}

async function sendSettings(tab) {
  await browser.tabs.sendMessage(tab.id, {
    type: 'auto-skip-settings',
    autoSkipLabs: settings.autoSkipLabs,
    autoSkipVideos: settings.autoSkipVideos
  });
}

async function toggleHelper() {
  settings.courseHelperEnabled = !settings.courseHelperEnabled;
  renderToggles();
  await browser.storage.local.set(settings);

  try {
    const tab = await getTab();
    if (settings.courseHelperEnabled) {
      try {
        await browser.tabs.sendMessage(tab.id, { type: 'start-monitoring' });
      } catch (_) {
        await inject(tab);
      }
      await sendSettings(tab).catch(() => {});
      showStatus('Course helper is on for this tab.');
    } else {
      await browser.tabs.sendMessage(tab.id, { type: 'stop-monitoring' }).catch(() => {});
      await browser.runtime.sendMessage({ type: 'stop-all-monitoring' }).catch(() => {});
      showStatus('Course helper is off for this tab.');
    }
  } catch (error) {
    showStatus('Could not access this tab. Open a course page and try again.');
    console.error(error);
  }
}

async function updateSkipSetting(key) {
  settings[key] = !settings[key];
  renderToggles();
  await browser.storage.local.set({ [key]: settings[key] });
  if (settings.courseHelperEnabled) {
    try { await sendSettings(await getTab()); }
    catch (error) { console.error('Could not update auto-skip settings:', error); }
  }
}

async function initialize() {
  try {
    const stored = await browser.storage.local.get(['courseHelperEnabled', 'autoSkipLabs', 'autoSkipVideos', 'lastMonitorStatus']);
    settings.courseHelperEnabled = stored.courseHelperEnabled === true;
    settings.autoSkipLabs = stored.autoSkipLabs !== false;
    settings.autoSkipVideos = stored.autoSkipVideos !== false;
    renderToggles();
    showStatus(settings.courseHelperEnabled
      ? (stored.lastMonitorStatus || 'Course helper is active on this tab.')
      : 'Turn on the course helper to begin.');
  } catch (_) {
    renderToggles();
  }
}

helperToggle.addEventListener('click', toggleHelper);
labsToggle.addEventListener('click', () => updateSkipSetting('autoSkipLabs'));
videosToggle.addEventListener('click', () => updateSkipSetting('autoSkipVideos'));

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'monitor-status') showStatus(message.status);
});

initialize();
