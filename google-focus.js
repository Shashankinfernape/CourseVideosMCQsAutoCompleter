(() => {
  if (window.__quizToGoogleComposerListener) return;
  window.__quizToGoogleComposerListener = true;

  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  function roots() {
    const found = [document];
    for (let index = 0; index < found.length; index += 1) {
      for (const element of Array.from(found[index].querySelectorAll('*'))) {
        if (element.shadowRoot) found.push(element.shadowRoot);
      }
    }
    return found;
  }

  function findComposer() {
    const selectors = 'textarea,[contenteditable="true"],[role="textbox"],input[type="text"]';
    const fields = roots().flatMap((root) => Array.from(root.querySelectorAll(selectors))).filter(visible);
    fields.sort((a, b) => {
      const label = (field) => `${field.getAttribute('aria-label') || ''} ${field.getAttribute('placeholder') || ''}`.toLowerCase();
      return Number(/ask|prompt|question|message/.test(label(b))) - Number(/ask|prompt|question|message/.test(label(a)));
    });
    return fields[0] || null;
  }

  function setComposerText(field, prompt) {
    field.focus();
    if (field.isContentEditable || field.getAttribute('contenteditable') === 'true' || field.getAttribute('role') === 'textbox') {
      const selection = field.ownerDocument.getSelection();
      const range = field.ownerDocument.createRange();
      range.selectNodeContents(field);
      selection.removeAllRanges();
      selection.addRange(range);
      const inserted = field.ownerDocument.execCommand('insertText', false, prompt);
      if (!inserted || !String(field.innerText || field.textContent || '').includes(prompt.slice(0, 80))) {
        field.textContent = prompt;
      }
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    } else {
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(field, prompt);
      else field.value = prompt;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return field.isContentEditable
      ? String(field.innerText || field.textContent || '').includes(prompt.slice(0, 80))
      : field.value === prompt;
  }

  function findSendButton(field) {
    const label = (button) => `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.getAttribute('data-tooltip') || ''} ${button.innerText || ''}`.trim().toLowerCase();
    const isSend = (button) => visible(button) && !button.disabled && /^(send|send message|submit)(\b|\s)/i.test(label(button));
    for (let ancestor = field.parentElement, depth = 0; ancestor && depth < 6; ancestor = ancestor.parentElement, depth += 1) {
      const match = Array.from(ancestor.querySelectorAll('button,[role="button"]')).find(isSend);
      if (match) return match;
    }
    return roots().flatMap((root) => Array.from(root.querySelectorAll('button,[role="button"]'))).find(isSend) || null;
  }

  function answerCandidates(optionCounts, multipleQuestions) {
    const records = (document.body?.innerText || '').split(/\r?\n/)
      .flatMap((line) => line.split(/;\s*(?=(?:(?:[SM]Q\.\s*)?(?:Q(?:uestion)?\s*)?\d{1,3})\s*[:.)-])/i))
      .map((line) => line.trim().replace(/^[`*_]+|[`*_]+$/g, '').replace(/^[-*]\s*/, '').trim())
      .filter((line) => Boolean(line) && !/^```/.test(line));
    const candidates = [];
    for (let start = 0; start <= records.length - optionCounts.length; start += 1) {
      const parsed = new Map();
      let valid = true;
      for (let offset = 0; offset < optionCounts.length; offset += 1) {
        const record = records[start + offset];
        const match = record.match(/^(?:([SM])Q\.\s*(\d{1,3})|(?:Q(?:uestion)?\s*)?(\d{1,3}))\s*[:.)-]\s*(\d+(?:\s*(?:,|\s)\s*\d+)*)\.?$/i);
        if (!match) { valid = false; break; }
        const questionNumber = Number(match[2] || match[3]);
        if (questionNumber !== offset + 1) { valid = false; break; }
        const picks = match[4].split(/\s*,\s*|\s+/).map(Number);
        const questionIndex = questionNumber - 1;
        const taggedMultiple = match[1] ? match[1].toUpperCase() === 'M' : multipleQuestions[questionIndex];
        if (questionIndex < 0 || questionIndex >= optionCounts.length || parsed.has(questionIndex) ||
            !picks.length || new Set(picks).size !== picks.length ||
            picks.some((pick) => pick < 1 || pick > optionCounts[questionIndex]) ||
            taggedMultiple !== multipleQuestions[questionIndex] ||
            (!multipleQuestions[questionIndex] && picks.length !== 1)) {
          valid = false;
          break;
        }
        parsed.set(questionIndex, picks.sort((a, b) => a - b));
      }
      if (!valid || parsed.size !== optionCounts.length) continue;
      const answers = optionCounts.map((_, index) => parsed.get(index));
      const formatted = answers.map((picks, index) => `${multipleQuestions[index] ? 'MQ' : 'SQ'}.${index + 1}: ${picks.join(',')}`).join('; ');
      candidates.push({ line: formatted, answers });
    }
    return candidates;
  }

  function watchForAnswer(optionCounts, multipleQuestions) {
    if (!Array.isArray(optionCounts) || !optionCounts.length || window.__quizToGeminiAnswerWatch) return;
    const oldCandidates = new Map();
    for (const candidate of answerCandidates(optionCounts, multipleQuestions)) {
      oldCandidates.set(candidate.line, (oldCandidates.get(candidate.line) || 0) + 1);
    }
    let previous = '';
    let stableSince = 0;
    const started = Date.now();
    window.__quizToGeminiAnswerWatch = setInterval(async () => {
      const current = answerCandidates(optionCounts, multipleQuestions);
      const currentCounts = new Map();
      let fresh = null;
      for (const candidate of current) {
        currentCounts.set(candidate.line, (currentCounts.get(candidate.line) || 0) + 1);
        if (!fresh && currentCounts.get(candidate.line) > (oldCandidates.get(candidate.line) || 0)) fresh = candidate;
      }
      if (fresh?.line === previous) {
        if (Date.now() - stableSince >= 1800) {
          clearInterval(window.__quizToGeminiAnswerWatch);
          window.__quizToGeminiAnswerWatch = null;
          try {
            await navigator.clipboard.writeText(fresh.answers.map((picks, index) => `${multipleQuestions[index] ? 'MQ' : 'SQ'}.${index + 1}: ${picks.join(',')}`).join('\n'));
          } catch (_) { /* clipboard access may be denied */ }
          browser.runtime.sendMessage({ type: 'ai-answers-result', answers: fresh.answers }).catch(() => {});
          return;
        }
      } else {
        previous = fresh?.line || '';
        stableSince = Date.now();
      }
      if (Date.now() - started > 120000) {
        clearInterval(window.__quizToGeminiAnswerWatch);
        window.__quizToGeminiAnswerWatch = null;
        browser.runtime.sendMessage({ type: 'ai-answer-timeout' }).catch(() => {});
      }
    }, 500);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'fill-ai-composer' || typeof message.prompt !== 'string') return;
    (async () => {
      const started = Date.now();
      while (Date.now() - started < 30000) {
        const field = findComposer();
        if (field) {
          let filled = false;
          try { filled = setComposerText(field, message.prompt); }
          catch (error) { console.error('Could not populate Google AI composer:', error); }
          if (!filled) {
            browser.runtime.sendMessage({ type: 'ai-focus-result', filled: false, submitted: false, focused: field.matches(':focus') }).catch(() => {});
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
          const sendButton = findSendButton(field);
          watchForAnswer(message.optionCounts, message.multipleQuestions || []);
          if (sendButton) sendButton.click();
          browser.runtime.sendMessage({ type: 'ai-focus-result', filled: true, submitted: Boolean(sendButton), focused: field.matches(':focus') }).catch(() => {});
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      browser.runtime.sendMessage({ type: 'ai-focus-result', filled: false, focused: false }).catch(() => {});
    })();
  });
})();
