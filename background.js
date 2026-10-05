const PREFACE = 'Each question is tagged SQ.n (single-answer radio question) or MQ.n (multiple-answer checkbox question). Follow the tag exactly, not the wording: give exactly one option number for SQ and every correct option number for MQ. Return only one line per question in order, repeating its tag, in this format: SQ.1: 2\nMQ.2: 1,3\nSQ.3: 4. Use option positions from that question, separate multiple options with commas, and include every question. No explanations.\n\n';
const waitingForFocus = new Map();
const monitoredTabs = new Set();

function normalizePrompt(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message?.type === 'stop-all-monitoring') {
    const tabIds = Array.from(monitoredTabs);
    await Promise.all(tabIds.map((tabId) => browser.tabs.sendMessage(tabId, { type: 'stop-monitoring' }).catch(() => {})));
    return;
  }

  if (message?.type === 'monitor-status') {
    const sourceTabId = sender.tab && sender.tab.id;
    if (typeof sourceTabId === 'number') {
      if (message.status === 'Monitoring stopped.') {
        monitoredTabs.delete(sourceTabId);
        for (const [aiTabId, waiting] of waitingForFocus) {
          if (waiting.sourceTabId === sourceTabId) waitingForFocus.delete(aiTabId);
        }
      }
      else monitoredTabs.add(sourceTabId);
    }
    return;
  }

  if (message?.type === 'ai-focus-result') {
    const aiTabId = sender.tab && sender.tab.id;
    const waiting = typeof aiTabId === 'number' ? waitingForFocus.get(aiTabId) : null;
    if (waiting && typeof waiting.sourceTabId === 'number') {
      browser.tabs.sendMessage(waiting.sourceTabId, {
        type: 'ai-submit-status',
        filled: Boolean(message.filled),
        submitted: Boolean(message.submitted),
        focused: Boolean(message.focused)
      }).catch(() => {});
    }
    return;
  }

  if (message?.type === 'ai-answers-result' && Array.isArray(message.answers)) {
    const aiTabId = sender.tab && sender.tab.id;
    const waiting = typeof aiTabId === 'number' ? waitingForFocus.get(aiTabId) : null;
    if (!waiting || typeof waiting.sourceTabId !== 'number') return;
    try {
      await browser.tabs.update(waiting.sourceTabId, { active: true });
      await browser.tabs.sendMessage(waiting.sourceTabId, { type: 'apply-ai-answers', answers: message.answers });
    } catch (error) {
      console.error('Could not return to the quiz page or select its answers:', error);
    }
    return;
  }

  if (message?.type === 'ai-answer-timeout') {
    const aiTabId = sender.tab && sender.tab.id;
    const waiting = typeof aiTabId === 'number' ? waitingForFocus.get(aiTabId) : null;
    if (waiting) {
      browser.tabs.sendMessage(waiting.sourceTabId, { type: 'ai-answer-timeout' }).catch(() => {});
    }
    return;
  }

  if (message?.type === 'quiz-cycle-complete' || message?.type === 'quiz-cycle-stalled') {
    // Keep the Gemini tab association so later quizzes in this course continue
    // in the same conversation. It is cleared when monitoring stops or a tab closes.
    return;
  }

  if (!message || message.type !== 'quiz-found' || !message.text) return;

  const tabId = sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') return;

  const payload = normalizePrompt(PREFACE + message.text);
  console.info(`[Quiz to Gemini] AI prompt (${payload.length} characters):`, JSON.stringify(payload));
  try {
    const existing = Array.from(waitingForFocus.entries()).find(([, waiting]) => waiting.sourceTabId === tabId);
    if (existing) {
      const [aiTabId, waiting] = existing;
      const missed = Array.isArray(message.previouslyWrong) ? message.previouslyWrong : [];
      const correction = missed.length
        ? `\n\nOn the previous attempt, these questions were answered incorrectly according to the quiz feedback:\n${missed.map((question) => `- ${question}`).join('\n')}\nThis is a retake with shuffled options. Correct your previous mistakes for those same questions. Keep the exact SQ.1: 2 / MQ.2: 1,3 response format and repeat each question's tag.`
        : '';
      waiting.prompt = normalizePrompt(payload + correction);
      waiting.optionCounts = Array.isArray(message.questions) ? message.questions.map((question) => question.options?.length || 0) : [];
      waiting.multipleQuestions = Array.isArray(message.questions) ? message.questions.map((question) => Boolean(question.multiple)) : [];
      await browser.tabs.update(aiTabId, { active: true });
      await browser.tabs.sendMessage(aiTabId, {
        type: 'fill-ai-composer',
        prompt: waiting.prompt,
        optionCounts: waiting.optionCounts,
        multipleQuestions: waiting.multipleQuestions
      });
      return;
    }
    const aiTab = await browser.tabs.create({ url: 'https://gemini.google.com/app', active: true });
    waitingForFocus.set(aiTab.id, {
      sourceTabId: tabId,
      prompt: payload,
      optionCounts: Array.isArray(message.questions) ? message.questions.map((question) => question.options?.length || 0) : [],
      multipleQuestions: Array.isArray(message.questions) ? message.questions.map((question) => Boolean(question.multiple)) : []
    });
    if (aiTab.status === 'complete') await prepareGoogleTab(aiTab.id);
  } catch (error) {
    console.error('Could not open Gemini:', error);
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  prepareGoogleTab(tabId);
  if (monitoredTabs.has(tabId)) {
    browser.tabs.executeScript(tabId, { file: 'content.js', allFrames: true }).catch((error) => {
      console.error('Could not resume quiz monitoring after navigation:', error);
    });
  }
});

async function prepareGoogleTab(tabId) {
  const waiting = waitingForFocus.get(tabId);
  if (!waiting || waiting.preparing) return;
  waiting.preparing = true;
  try {
    await browser.tabs.executeScript(tabId, { file: 'google-focus.js' });
    await browser.tabs.sendMessage(tabId, {
      type: 'fill-ai-composer',
      prompt: waiting.prompt,
      optionCounts: waiting.optionCounts,
      multipleQuestions: waiting.multipleQuestions
    });
  } catch (error) {
    waiting.preparing = false;
    console.error('Could not fill Gemini composer:', error);
  }
}

browser.tabs.onRemoved.addListener((tabId) => {
  waitingForFocus.delete(tabId);
  monitoredTabs.delete(tabId);
  for (const [aiTabId, waiting] of waitingForFocus) {
    if (waiting.sourceTabId === tabId) waitingForFocus.delete(aiTabId);
  }
});
