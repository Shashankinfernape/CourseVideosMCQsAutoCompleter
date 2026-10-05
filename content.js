(() => {
  // The course quiz lives in the top-level page; avoid duplicate scans from embedded frames.
  if (window.top !== window) return;
  if (window.__quizToGoogleObserver) return;

  const PREFACE = 'Each question is tagged SQ.n (single-answer radio question) or MQ.n (multiple-answer checkbox question). Follow the tag exactly, not the wording: give exactly one option number for SQ and every correct option number for MQ. Return only one line per question in order, repeating its tag, in this format: SQ.1: 2\nMQ.2: 1,3\nSQ.3: 4. Use option positions from that question, separate multiple options with commas, and include every question. No explanations.\n\n';
  const normalizePrompt = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  let timer = null;
  let poller = null;
  let lastFingerprint = '';
  let pendingFingerprint = '';
  let pendingSince = 0;
  let lastStatus = '';
  let scanInProgress = false;
  let lastDiagnostics = '';
  let firstQuestionOnly = false;
  let testOnlyAttempt = false;
  let wrongQuestionHistory = [];
  let outcomeTimer = null;
  let outcomeStarted = 0;
  let attemptSnapshot = [];
  let lastAutoSkipSignature = '';
  let videoNextRetryTimer = null;
  let videoNextRetrySignature = '';
  let videoNextRetryDeadline = 0;
  let videoCompletionClickedSignature = '';
  let autoSkipLabs = true;
  let autoSkipVideos = true;
  let settingsReady = false;
  let quizOutcomePending = false;

  browser.storage.local.get(['autoSkipLabs', 'autoSkipVideos']).then((settings) => {
    autoSkipLabs = settings.autoSkipLabs !== false;
    autoSkipVideos = settings.autoSkipVideos !== false;
    settingsReady = true;
  }).catch(() => { settingsReady = true; });

  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function getOpenRoots(start = document) {
    const roots = [start];
    if (start.nodeType === Node.ELEMENT_NODE && start.shadowRoot) roots.push(start.shadowRoot);
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const element of Array.from(root.querySelectorAll('*'))) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function getPageLines(roots) {
    const lines = [];
    for (const root of roots) {
      if (root === document) {
        lines.push(...(document.body?.innerText || '').split(/\r?\n/));
        continue;
      }
      if (root.nodeType === Node.ELEMENT_NODE) {
        lines.push(...getElementLines(root));
        continue;
      }
      const leaves = Array.from(root.querySelectorAll('*')).filter((element) =>
        visible(element) && element.children.length === 0 && clean(element.innerText || element.textContent)
      );
      if (leaves.length) {
        lines.push(...leaves.map((element) => element.innerText || element.textContent));
      } else {
        lines.push(root.textContent || '');
      }
    }
    return lines.map((line) => clean(line.replace(/\u00a0/g, ' '))).filter(Boolean);
  }

  function getElementLines(element) {
    return (element?.innerText || element?.textContent || '')
      .split(/\r?\n/)
      .map((line) => clean(line.replace(/\u00a0/g, ' ')))
      .filter(Boolean);
  }

  function findQuizRegion(roots) {
    const candidates = [];
    for (const root of roots) {
      const exactQuizLabels = Array.from(root.querySelectorAll('*')).filter((element) =>
        visible(element) && clean(element.innerText || element.textContent).toLowerCase() === 'quiz'
      );
      for (const label of exactQuizLabels) {
        let region = label;
        for (let depth = 0; region && depth < 12; depth += 1, region = region.parentElement) {
          const regionRoots = getOpenRoots(region);
          const lines = getPageLines(regionRoots);
          const text = lines.join(' ');
          const controls = regionRoots.flatMap((item) => Array.from(item.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]'))).length;
          const numbered = lines.some((line) => /^\d{1,3}[.)](?:\s|$)/.test(line));
          const hasPassingScore = /passing\s+score\s*:\s*\d+(?:\.\d+)?\s*%/i.test(text);
          const hasQuizResult = /\byour\s+score\s*:\s*\d+(?:\.\d+)?\s*%/i.test(text);
          if (hasPassingScore && (hasQuizResult || lines.some(looksLikeQuestion) || numbered || controls >= 2)) {
            candidates.push({ region, score: text.length });
            break;
          }
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0]?.region || null;
  }

  function nearestCommonAncestor(elements) {
    if (!elements.length) return null;
    let node = elements[0];
    while (node && !elements.every((element) => node.contains(element))) node = node.parentElement;
    return node;
  }

  function getOptionText(input) {
    const aria = clean(input.getAttribute('aria-label') || '');
    if (aria) return aria;
    const labelledBy = (input.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id) => input.getRootNode().getElementById?.(id)).filter(Boolean)
      .map((node) => clean(node.innerText || node.textContent)).filter(Boolean).join(' ');
    if (labelledBy) return labelledBy;
    const labels = Array.from(input.labels || []);
    const text = labels.map((label) => clean(label.innerText || label.textContent)).filter(Boolean).join(' ');
    if (text) return text;
    const wrapper = input.closest('label');
    if (wrapper) return clean(wrapper.innerText || wrapper.textContent);
    const ownText = clean(input.innerText || input.textContent || '');
    return ownText || clean(input.value || '');
  }

  function visibleOptionControl(control) {
    return visible(control) ||
      Array.from(control.labels || []).some(visible) ||
      visible(control.closest('label'));
  }

  function isMultiControl(control) {
    return control.matches('input[type="checkbox"], [role="checkbox"]');
  }

  function looksLikeQuestion(text) {
    const value = clean(text).replace(/^\d{1,3}[.)]\s*/, '');
    return /\?/.test(value) ||
      /\b(which|what|where|who|when|why|how)\b/i.test(value) ||
      /^(select|choose|identify|name|complete|fill|is|are|does|do|can|will|would)\b/i.test(value);
  }

  function likelyMultipleAnswerQuestion(text) {
    return /\b(?:two|both|multiple answers?|all that apply|select all|choose all)\b/i.test(clean(text));
  }

  function getAccessibleText(element, root) {
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const referenced = labelledBy.map((id) => root.getElementById?.(id)).filter(Boolean)
      .map((node) => clean(node.innerText || node.textContent)).filter(Boolean).join(' ');
    return clean(element.getAttribute('aria-label') || referenced || element.innerText || element.textContent);
  }

  function findQuestionBefore(group) {
    let branch = group;
    while (branch?.parentElement) {
      const parent = branch.parentElement;
      const siblings = Array.from(parent.children);
      const branchIndex = siblings.indexOf(branch);
      for (let index = branchIndex - 1; index >= 0; index -= 1) {
        const text = clean(siblings[index].innerText || siblings[index].textContent);
        if (looksLikeQuestion(text)) return text;
      }
      branch = parent;
    }
    return '';
  }

  function getQuestionContainer(inputs, quizRegion) {
    const common = nearestCommonAncestor(inputs);
    if (!common) return null;
    const fieldset = inputs[0].closest('fieldset');
    if (fieldset && inputs.every((input) => fieldset.contains(input))) return fieldset;

    let candidate = common;
    for (let node = common; node && node !== quizRegion; node = node.parentElement) {
      const names = new Set(Array.from(node.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter(visible).map((input) => input.name || input.id || input));
      if (names.size > 1) break;
      candidate = node;
      if (node.matches('li, article, [role="group"], [role="radiogroup"]')) break;
    }
    return candidate;
  }

  function getQuestionText(container, optionTexts) {
    const clone = container.cloneNode(true);
    clone.querySelectorAll('input[type="radio"], label, button, script, style').forEach((node) => node.remove());
    let text = clean(clone.innerText || clone.textContent);
    for (const option of optionTexts) {
      if (option) text = clean(text.replace(option, ' '));
    }
    return text;
  }

  function collectQuestions() {
    const pageRoots = getOpenRoots();
    const quizRegion = findQuizRegion(pageRoots);
    if (!quizRegion) {
      lastDiagnostics = `${location.hostname || 'this page'}: no visible Quiz section found`;
      return [];
    }

    const roots = getOpenRoots(quizRegion);
    const lines = getPageLines(roots);
    const ariaQuestions = [];
    let ariaGroupCount = 0;
    for (const root of roots) {
      const groups = Array.from(root.querySelectorAll('[role="radiogroup"], [role="group"], [role="checkboxgroup"], fieldset')).filter(visible);
      ariaGroupCount += groups.length;
      for (const group of groups) {
        const controls = Array.from(group.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]')).filter(visibleOptionControl);
        const options = controls.map((control) => getAccessibleText(control, root)).filter(Boolean);
        const question = findQuestionBefore(group) || questionFromText(group.innerText || group.textContent, options);
        if (question && options.length >= 2 && options.length <= 8) ariaQuestions.push({ question, options, controls, multiple: controls.some(isMultiControl) || likelyMultipleAnswerQuestion(question) });
      }
    }
    const selector = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"], [aria-checked="true"], [aria-checked="false"], [aria-pressed="true"], [aria-pressed="false"]';
    const controls = roots.flatMap((root) => Array.from(root.querySelectorAll(selector))).filter(visibleOptionControl);
    const questionLikeLines = lines.filter(looksLikeQuestion).length;
    const numberedLines = lines.filter((line) => /^\d{1,3}[.)](?:\s|$)/.test(line)).length;
    lastDiagnostics = `${location.hostname || 'this page'}: quiz section found; ${lines.length} text lines, ${questionLikeLines} question-like lines, ${numberedLines} numbered lines, ${controls.length} answer controls, ${ariaGroupCount} groups`;

    const groups = new Map();
    for (const control of controls) {
      const explicit = control.closest('[role="radiogroup"], [role="group"], [role="checkboxgroup"], fieldset');
      const key = explicit || (control.matches('input[type="radio"], input[type="checkbox"]') && control.name
        ? `name:${control.form?.id || ''}:${control.name}`
        : null);
      if (key) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(control);
      }
    }

    // Keep every well-formed semantic group, then scan controls that those
    // groups did not cover. Some course questions use different markup, so
    // returning the first partial set can silently omit a listed question.
    const questions = [...ariaQuestions];
    const used = new Set(ariaQuestions.flatMap((question) => question.controls || []));
    const knownQuestionText = new Set(questions.map((question) => clean(question.question).toLowerCase()));
    for (const [group, groupControls] of groups) {
      const uncoveredControls = groupControls.filter((control) => !used.has(control));
      if (uncoveredControls.length < 2) continue;
      const options = uniqueTexts(uncoveredControls.map(getOptionText));
      const container = typeof group === 'string' ? nearestCommonAncestor(uncoveredControls) : group;
      const question = questionFromText(container?.innerText || container?.textContent, options) ||
        (typeof group === 'string' ? '' : findQuestionBefore(group));
      if (question && options.length >= 2 && options.length <= 8 && !knownQuestionText.has(question.toLowerCase())) {
        questions.push({ question, options, controls: uncoveredControls, multiple: uncoveredControls.some(isMultiControl) || likelyMultipleAnswerQuestion(question) });
        knownQuestionText.add(question.toLowerCase());
        uncoveredControls.forEach((control) => used.add(control));
      }
    }

    // For controls without semantic group markup, find the smallest shared
    // ancestor that contains several options and a question prompt.
    const remaining = controls.filter((control) => !used.has(control));
    const structural = [];
    for (const control of remaining) {
      for (let container = control.parentElement, depth = 0; container && container !== quizRegion && depth < 10; container = container.parentElement, depth += 1) {
        const contained = remaining.filter((other) => container.contains(other));
        if (contained.length < 2 || contained.length > 8) continue;
        const options = uniqueTexts(contained.map(getOptionText));
        if (options.length < 2 || options.length > 8) continue;
        const question = questionFromText(container.innerText || container.textContent, options);
        if (question) structural.push({ container, contained, question, options });
      }
    }
    structural.sort((a, b) => (a.container.innerText || '').length - (b.container.innerText || '').length);
    for (const candidate of structural) {
      if (candidate.contained.every((control) => used.has(control))) continue;
      if (knownQuestionText.has(candidate.question.toLowerCase())) {
        candidate.contained.forEach((control) => used.add(control));
        continue;
      }
      questions.push({ question: candidate.question, options: candidate.options, controls: candidate.contained, multiple: candidate.contained.some(isMultiControl) || likelyMultipleAnswerQuestion(candidate.question) });
      knownQuestionText.add(candidate.question.toLowerCase());
      candidate.contained.forEach((control) => used.add(control));
    }

    // Recover question text from the quiz's own numbered text when its
    // controls use markup that the structural scan cannot associate. Keep
    // this list as the ordering authority so checkbox questions without
    // directly associated controls do not jump ahead of nearby radio items.
    const textQuestions = collectNumberedTextQuestions(lines);
    for (const textQuestion of textQuestions) {
      const key = clean(textQuestion.question).toLowerCase();
      if (!knownQuestionText.has(key)) {
        questions.push({ ...textQuestion, multiple: likelyMultipleAnswerQuestion(textQuestion.question) });
        knownQuestionText.add(key);
      }
    }

    const questionOrderIndex = (question) => {
      const prompt = clean(question.question).toLowerCase();
      const textIndex = textQuestions.findIndex((candidate) => clean(candidate.question).toLowerCase() === prompt);
      if (textIndex >= 0) return textIndex;
      return lines.findIndex((line) => clean(line).toLowerCase().includes(prompt));
    };
    questions.sort((a, b) => {
      const orderA = questionOrderIndex(a);
      const orderB = questionOrderIndex(b);
      if (orderA >= 0 && orderB >= 0 && orderA !== orderB) return orderA - orderB;
      const firstA = a.controls?.[0];
      const firstB = b.controls?.[0];
      if (firstA && firstB && firstA.getRootNode() === firstB.getRootNode()) {
        const position = firstA.compareDocumentPosition(firstB);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      }
      return (firstA?.getBoundingClientRect().top ?? 0) - (firstB?.getBoundingClientRect().top ?? 0);
    });

    return questions;
  }

  function uniqueTexts(values) {
    return Array.from(new Set(values.map(clean).filter((value) => value && value.length > 1)));
  }

  function questionFromText(text, options) {
    let residual = clean(text || '');
    for (const option of options) {
      if (option) residual = clean(residual.split(option).join(' '));
    }
    const lines = residual.split(/\r?\n/).map(clean).filter(Boolean);
    const question = lines.find(looksLikeQuestion) || (looksLikeQuestion(residual) ? residual : '');
    return clean(question.replace(/^\d{1,3}[.)]\s*/, ''));
  }

  function collectNumberedTextQuestions(lines) {
    const ignored = /^(quiz|passing score\s*:.*|submit|check answer|next|previous|show answer|explanation|contents|not right now|dashboard|cloud|credentials|certificate|skill badge|certification)$/i;
    const questions = [];
    for (let index = 0; index < lines.length; index += 1) {
      const question = lines[index];
      if (ignored.test(question) || !looksLikeQuestion(question)) continue;

      const options = [];
      for (let next = index + 1; next < lines.length && options.length < 4; next += 1) {
        const line = lines[next];
        if (/^\d{1,3}[.)](?:\s|$)/.test(line) || looksLikeQuestion(line)) break;
        if (!ignored.test(line) && line.length > 2) options.push(line);
      }
      if (options.length >= 2) {
        questions.push({ question: question.replace(/^\d{1,3}[.)]\s*/, ''), options });
      }
    }
    return questions;
  }

  function numberedQuestionCount(region) {
    if (!region) return 0;
    const lines = getPageLines(getOpenRoots(region));
    const numbers = lines.map((line) => {
      const match = line.match(/^(\d{1,3})[.)](?:\s*(.*))?$/);
      if (!match || (match[2] && !looksLikeQuestion(match[2]))) return null;
      return Number(match[1]);
    }).filter((number) => number !== null);
    return numbers.length >= 2 ? Math.max(...numbers) : 0;
  }

  function formatQuestions(questions) {
    return questions.map(({ question, options, multiple }, index) => {
      const isMultiple = Boolean(multiple || likelyMultipleAnswerQuestion(question));
      return `${isMultiple ? 'MQ' : 'SQ'}.${index + 1}. ${question}\n${options.map((option, optionIndex) => `${optionIndex + 1}. ${option}`).join('\n')}`;
    }).join('\n\n');
  }

  function isMultipleQuestion(question) {
    return Boolean(question.multiple || likelyMultipleAnswerQuestion(question.question));
  }

  function applyAnswers(answers) {
    const questions = collectQuestions();
    if (!Array.isArray(answers) || answers.length !== questions.length) {
      setStatus(`Got ${Array.isArray(answers) ? answers.length : 0} answers for ${questions.length} detected questions; nothing was selected.`);
      return;
    }
    const normalizedAnswers = answers.map((answer) => Array.isArray(answer) ? answer : [answer]);
    const invalid = questions.some((question, index) => {
      const picks = normalizedAnswers[index];
      return !question.controls || question.controls.length < question.options.length ||
        !picks.length || (!isMultipleQuestion(question) && picks.length !== 1) ||
        (picks.length > 1 && !question.controls.some(isMultiControl)) ||
        new Set(picks).size !== picks.length ||
        picks.some((pick) => !Number.isInteger(pick) || pick < 1 || pick > question.options.length || !question.controls[pick - 1]);
    });
    if (invalid) {
      setStatus('Gemini’s answers did not match every question and option control; nothing was selected. Check the answers manually.');
      return;
    }

    let selected = 0;
    questions.forEach((question, index) => {
      const picks = new Set(normalizedAnswers[index]);
      question.controls.forEach((control, optionIndex) => {
        const shouldSelect = picks.has(optionIndex + 1);
        const isSelected = () => control.checked === true || control.getAttribute('aria-checked') === 'true' || control.getAttribute('aria-pressed') === 'true';
        if (isSelected() !== shouldSelect) {
          control.click();
          if (isSelected() !== shouldSelect) {
            const label = control.closest('label') || Array.from(control.labels || [])[0];
            if (label) label.click();
          }
        }
      });
      selected += picks.size;
    });
    attemptSnapshot = questions.map((question, index) => ({ question: question.question, answer: normalizedAnswers[index] }));
    if (testOnlyAttempt) {
      testOnlyAttempt = false;
      setStatus('Selected the test answer only. It was not submitted.');
      return;
    }
    setStatus(`Selected ${selected} options. Submitting this validation attempt…`);
    setTimeout(() => submitAttempt(), 500);
  }

  function findQuizAction(pattern) {
    const region = findQuizRegion(getOpenRoots());
    if (!region) return null;
    const candidates = getOpenRoots(region).flatMap((root) => Array.from(root.querySelectorAll('button,[role="button"]'))).filter(visible);
    return candidates.find((element) => {
      const label = clean(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.innerText || element.textContent || ''}`);
      return pattern.test(label) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    }) || null;
  }

  function findPageNextButton() {
    const candidates = getOpenRoots().flatMap((root) => Array.from(root.querySelectorAll(
      'button,[role="button"],a,[tabindex="0"]'
    ))).filter(visible);
    return candidates.find((element) => {
      const label = clean(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.getAttribute('data-tooltip') || ''} ${element.innerText || element.textContent || ''}`);
      return /^next(?:\b|\s)/i.test(label) &&
        !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    }) || null;
  }

  function findMarkAsCompletedButton() {
    const candidates = getOpenRoots().flatMap((root) => Array.from(root.querySelectorAll(
      'button,[role="button"],a,[tabindex="0"]'
    ))).filter(visible);
    return candidates.find((element) => {
      const label = clean(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.getAttribute('data-tooltip') || ''} ${element.innerText || element.textContent || ''}`);
      return /\bmark\s+(?:as\s+)?completed?\b/i.test(label) &&
        !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    }) || null;
  }

  function retryVideoNext(signature) {
    if (videoNextRetryTimer !== null && videoNextRetrySignature === signature) return;
    if (videoNextRetryTimer !== null) clearTimeout(videoNextRetryTimer);
    videoNextRetrySignature = signature;
    videoNextRetryDeadline = Date.now() + 15000;
    const retry = () => {
      videoNextRetryTimer = null;
      if (videoNextRetrySignature !== signature) return;
      const next = findPageNextButton();
      if (next) {
        videoNextRetrySignature = '';
        videoCompletionClickedSignature = '';
        lastAutoSkipSignature = signature;
        setStatus('Video detected; opening Next…');
        next.click();
        return;
      }
      if (videoCompletionClickedSignature !== location.href) {
        const markComplete = findMarkAsCompletedButton();
        if (markComplete) {
          videoCompletionClickedSignature = location.href;
          setStatus('Next is unavailable; marking the video as completed…');
          markComplete.click();
        }
      }
      if (Date.now() >= videoNextRetryDeadline) {
        videoNextRetrySignature = '';
        setStatus('Video detected, but no Next button appeared. Check the course page.');
        return;
      }
      videoNextRetryTimer = setTimeout(retry, 100);
    };
    videoNextRetryTimer = setTimeout(retry, 50);
  }

  function skipLabOrVideo() {
    if (window.top !== window) return false;
    if (findQuizRegion(getOpenRoots())) return false;
    const roots = getOpenRoots();
    const mains = roots.flatMap((root) => Array.from(root.querySelectorAll('main,[role="main"]'))).filter(visible);
    const main = mains.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0] || document.body;
    if (!main) return false;

    const headings = roots.flatMap((root) => Array.from(root.querySelectorAll('h1,h2,h3,[role="heading"]')))
      .filter(visible).map((element) => clean(element.innerText || element.textContent));
    const fullPageText = clean(getPageLines(roots).join(' '));
    const actionLabels = roots.flatMap((root) => Array.from(root.querySelectorAll('button,[role="button"],a,[tabindex="0"]')))
      .filter(visible).map((element) => clean(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.innerText || element.textContent || ''}`));
    const activityText = clean(`${headings.join(' ')} ${main.innerText || main.textContent || ''} ${fullPageText} ${actionLabels.join(' ')}`);
    const videoElements = roots.flatMap((root) => Array.from(root.querySelectorAll(
      'video,iframe,[aria-label*="video" i],[data-testid*="video" i],[class*="video-player" i],[data-media-player]'
    ))).filter(visible);
    const hasVideoPlayer = videoElements.some((element) => {
      if (element.tagName.toLowerCase() !== 'iframe') return true;
      const label = `${element.getAttribute('src') || ''} ${element.getAttribute('title') || ''} ${element.getAttribute('aria-label') || ''}`;
      const rect = element.getBoundingClientRect();
      const aspect = rect.height ? rect.width / rect.height : 0;
      return /video|youtube|youtu\.be|player/i.test(label) ||
        (rect.width >= 220 && rect.height >= 120 && aspect >= 1.25 && aspect <= 2.3);
    }) || roots.some((root) => Array.from(root.querySelectorAll(
      'button[aria-label*="play video" i],button[aria-label*="pause video" i],[title*="play video" i],[aria-label*="video player" i]'
    )).some(visible));
    const isVideo = autoSkipVideos && hasVideoPlayer;
    const hasLabContext = /\b(?:lab|laboratory|hands-on lab)\b/i.test(`${headings.join(' ')} ${fullPageText}`);
    const hasExplicitLabAction = actionLabels.some((label) =>
      /\b(?:start|launch|begin|open|resume)\b.{0,32}\b(?:this\s+|the\s+)?lab\b|\b(?:this\s+|the\s+)?lab\b.{0,32}\b(?:start|launch|begin|open|resume)\b/i.test(label)
    );
    const hasStartAction = actionLabels.some((label) => /^\s*(?:start|launch|begin|open|resume)(?:\b|\s)/i.test(label));
    const isLab = autoSkipLabs && (
      headings.some((heading) => /\blab\b/i.test(heading)) ||
      hasExplicitLabAction ||
      (hasLabContext && (/\blab instructions\b/i.test(activityText) || hasStartAction))
    );
    if (!isVideo && !isLab) return false;

    const type = isVideo ? 'video' : 'lab';
    const signature = `${location.href}|${type}|${headings.join('|')}|${activityText.slice(0, 160)}`;
    if (signature === lastAutoSkipSignature) return true;

    const next = findPageNextButton();
    if (!next) {
      if (isVideo) {
        setStatus('Video detected; checking Next and Mark as completed…');
        retryVideoNext(signature);
      } else {
        setStatus(`Detected a ${type} activity, but no Next button was found. Stopped here.`);
      }
      return true;
    }
    if (videoNextRetryTimer !== null) clearTimeout(videoNextRetryTimer);
    videoNextRetryTimer = null;
    videoNextRetrySignature = '';
    if (isVideo) videoCompletionClickedSignature = '';
    lastAutoSkipSignature = signature;
    setStatus(`Skipping ${type} activity; opening the next item…`);
    next.click();
    return true;
  }

  function submitAttempt() {
    const submit = findQuizAction(/^submit(?:\b|\s)/i) || findQuizAction(/^check answer(?:\b|\s)/i);
    if (!submit) {
      setStatus('Answers are selected, but I could not find the quiz Submit button. Submit this attempt manually.');
      return;
    }
    quizOutcomePending = true;
    submit.click();
    outcomeStarted = Date.now();
    if (outcomeTimer !== null) clearInterval(outcomeTimer);
    outcomeTimer = setInterval(checkAttemptOutcome, 500);
  }

  function pageStamp() {
    return `${location.href}|${document.title}|${clean(document.body?.innerText || '')}`;
  }

  function hasDisplayedScore() {
    const text = clean(document.body?.innerText || '')
      .replace(/passing\s+score\s*:\s*\d+(?:\.\d+)?\s*%/gi, ' ');
    return /\b(?:your\s+)?(?:score|scored)\s*:?\s*\d/i.test(text);
  }

  function waitForCourseTransition(previousStamp, description) {
    const started = Date.now();
    const transitionPoller = setInterval(() => {
      if (pageStamp() !== previousStamp && !hasDisplayedScore()) {
        clearInterval(transitionPoller);
        quizOutcomePending = false;
        lastFingerprint = '';
        pendingFingerprint = '';
        lastAutoSkipSignature = '';
        setStatus(`${description}; checking the new course item…`);
        scheduleScan();
      } else if (Date.now() - started > 30000) {
        clearInterval(transitionPoller);
        setStatus(`Clicked ${description.toLowerCase()}, but the page did not change. Check the course page.`);
      }
    }, 300);
  }

  function advanceAfterPassing(score, passingScore, alreadyCompleted = false) {
    const before = pageStamp();
    const started = Date.now();
    const report = alreadyCompleted ? 'Quiz was already completed' : 'Score report';
    const nextPoller = setInterval(() => {
      const next = findPageNextButton();
      if (next) {
        clearInterval(nextPoller);
        browser.runtime.sendMessage({ type: 'quiz-cycle-complete' }).catch(() => {});
        setStatus(`${report}: ${score}% (passing score: ${passingScore}%). Passing threshold met; moving to the next page.`);
        next.click();
        waitForCourseTransition(before, 'Opened the next item');
        return;
      }
      if (Date.now() - started > 10000) {
        clearInterval(nextPoller);
        setStatus(`${report}: ${score}% (passing score: ${passingScore}%). Passing threshold met, but no Next button appeared. Click Next manually.`);
        waitForCourseTransition(before, 'Opened the next item');
      }
    }, 350);
  }

  function wrongQuestionsFromFeedback(questions, region) {
    const wrong = [];
    for (const question of questions) {
      const group = question.controls?.length ? getQuestionContainer(question.controls, region) : null;
      let branch = group;
      let isWrong = false;
      for (let depth = 0; branch && branch !== region && depth < 8; depth += 1, branch = branch.parentElement) {
        const attrs = `${branch.className || ''} ${branch.getAttribute?.('aria-label') || ''} ${branch.getAttribute?.('title') || ''}`;
        const ownLines = getElementLines(branch);
        if (/\b(incorrect|wrong|not correct)\b/i.test(attrs) || ownLines.some((line) => /^(incorrect|wrong answer|not correct)$/i.test(line))) {
          isWrong = true;
          break;
        }
      }
      if (isWrong) wrong.push(question.question);
    }
    return Array.from(new Set(wrong));
  }

  function readQuizScores(region) {
    if (!region) return { score: null, passingScore: null };
    const text = getPageLines(getOpenRoots(region)).join('\n');
    const passMatch = text.match(/passing\s+score\s*:\s*(\d+(?:\.\d+)?)\s*%/i);
    const passingScore = passMatch ? Number(passMatch[1]) : null;
    const scoreText = text.replace(/passing\s+score\s*:\s*\d+(?:\.\d+)?\s*%/gi, ' ');
    let score = null;
    for (const line of scoreText.split(/\r?\n/)) {
      const percent = line.match(/\b(?:your\s+)?(?:score|scored)\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);
      if (percent) { score = Number(percent[1]); break; }
      const ratio = line.match(/\b(?:your\s+)?(?:score|scored)\s*:?\s*(\d+)\s*(?:out of|\/)\s*(\d+)\b/i);
      if (ratio && Number(ratio[2]) > 0) { score = (Number(ratio[1]) / Number(ratio[2])) * 100; break; }
    }
    return { score, passingScore };
  }

  function checkAttemptOutcome() {
    const roots = getOpenRoots();
    const region = findQuizRegion(roots);
    if (!region) return;
    const { score, passingScore } = readQuizScores(region);
    if (score !== null && passingScore !== null && score >= passingScore) {
      clearInterval(outcomeTimer);
      outcomeTimer = null;
      setStatus(`Score report: ${score}% (passing score: ${passingScore}%). Passing threshold met; looking for Next…`);
      advanceAfterPassing(score, passingScore);
      return;
    }
    if (score !== null && passingScore !== null && score < passingScore) {
      clearInterval(outcomeTimer);
      outcomeTimer = null;
      const questions = collectQuestions();
      const wrongQuestions = wrongQuestionsFromFeedback(questions, region);
      if (!wrongQuestions.length) {
        setStatus(`Score ${score}% is below ${passingScore}%, but the page did not identify which questions were wrong. Stopped without retaking.`);
        browser.runtime.sendMessage({ type: 'quiz-cycle-stalled' }).catch(() => {});
        return;
      }
      wrongQuestionHistory = [...wrongQuestionHistory, ...wrongQuestions.filter((item) => !wrongQuestionHistory.includes(item))];
      setStatus(`Score report: ${score}% (passing score: ${passingScore}%). Recorded ${wrongQuestions.length} missed question${wrongQuestions.length === 1 ? '' : 's'}; retaking with shuffled questions…`);
      const retake = findQuizAction(/^retake(?:\b|\s)/i) || findQuizAction(/^try again(?:\b|\s)/i);
      if (retake) {
        const before = pageStamp();
        lastFingerprint = '';
        pendingFingerprint = '';
        retake.click();
        waitForCourseTransition(before, 'Opened the retake');
      }
      else {
        setStatus('Missed questions were recorded, but no Retake button was found. Start the retake manually.');
        const before = pageStamp();
        waitForCourseTransition(before, 'Opened the retake');
      }
      return;
    }
    if (Date.now() - outcomeStarted > 20000) {
      clearInterval(outcomeTimer);
      outcomeTimer = null;
      setStatus(score !== null && passingScore === null
        ? `Score ${score}% was detected, but this quiz page's passing score could not be read. Stopped without advancing or retaking.`
        : 'Submitted, but the score was not detected. Check the result and continue manually.');
      browser.runtime.sendMessage({ type: 'quiz-cycle-stalled' }).catch(() => {});
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.documentElement.appendChild(textarea);
      textarea.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_) { /* clipboard may be unavailable */ }
      textarea.remove();
      return copied;
    }
  }

  async function scan() {
    timer = null;
    if (scanInProgress) return;
    if (quizOutcomePending) return;
    if (!settingsReady) {
      timer = setTimeout(scan, 250);
      return;
    }
    scanInProgress = true;
    try {
      observeAvailableRoots();
      const quizRegion = findQuizRegion(getOpenRoots());
      const existingResult = readQuizScores(quizRegion);
      if (quizRegion && existingResult.score !== null && existingResult.passingScore !== null &&
          existingResult.score >= existingResult.passingScore) {
        quizOutcomePending = true;
        setStatus(`Completed quiz found: score ${existingResult.score}%, passing score ${existingResult.passingScore}%. Opening Next…`);
        advanceAfterPassing(existingResult.score, existingResult.passingScore, true);
        return;
      }
      let questions = collectQuestions();
      if (!questions.length) {
        if (skipLabOrVideo()) return;
        setStatus(`Monitoring; no quiz detected. ${lastDiagnostics}`);
        return;
      }
      const expectedCount = numberedQuestionCount(quizRegion);
      if (expectedCount > questions.length) {
        setStatus(`Found ${questions.length} of ${expectedCount} numbered questions; waiting until all quiz questions are available.`);
        return;
      }
      lastAutoSkipSignature = '';
      if (firstQuestionOnly) {
        questions = questions.slice(0, 1);
        firstQuestionOnly = false;
        testOnlyAttempt = true;
      }

      const text = formatQuestions(questions);
      const fingerprint = text;
      if (fingerprint === lastFingerprint) return;
      if (fingerprint !== pendingFingerprint) {
        pendingFingerprint = fingerprint;
        pendingSince = Date.now();
        setStatus(`Quiz found (${questions.length} questions); waiting for the page to finish loading…`);
        return;
      }
      if (Date.now() - pendingSince < 2500) return;

      lastFingerprint = fingerprint;
      const structuredQuestions = questions.map((item, index) => ({ number: index + 1, question: item.question, options: item.options, multiple: isMultipleQuestion(item) }));
      const copied = await copyText(normalizePrompt(PREFACE + text));
      if (!copied) {
        setStatus('Quiz found, but clipboard copy failed. Allow clipboard access and scan again.');
        return;
      }
      browser.runtime.sendMessage({
        type: 'quiz-found',
        text,
        count: questions.length,
        questions: structuredQuestions,
        previouslyWrong: wrongQuestionHistory
      }).catch((error) => {
        console.error('Could not send quiz to the extension background:', error);
      });
      setStatus(`Copied ${questions.length} question${questions.length === 1 ? '' : 's'} with the prompt; opening Gemini and filling its message box…`);
    } catch (error) {
      console.error('Quiz scan failed:', error);
      setStatus('Scan failed on this page. Check the browser console or share the page URL.');
    } finally {
      scanInProgress = false;
    }
  }

  function scheduleScan(delay = 20) {
    // Throttle instead of debouncing so a video player can advance promptly
    // even while the page is still rendering or animating.
    if (timer !== null) return;
    timer = setTimeout(scan, delay);
  }

  function setStatus(status) {
    if (status === lastStatus) return;
    lastStatus = status;
    browser.storage.local.set({ lastMonitorStatus: status }).catch(() => {});
    browser.runtime.sendMessage({ type: 'monitor-status', status }).catch(() => {});
  }

  let observedRoots = new WeakSet();
  const observer = new MutationObserver(() => {
    observeAvailableRoots();
    scheduleScan();
  });
  function observeAvailableRoots() {
    for (const root of getOpenRoots()) {
      if (observedRoots.has(root)) continue;
      const target = root === document ? document.documentElement : root;
      if (!target) continue;
      observer.observe(target, { subtree: true, childList: true, characterData: true });
      observedRoots.add(root);
    }
  }
  observeAvailableRoots();
  window.__quizToGoogleObserver = observer;
  poller = setInterval(scan, 2000);
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'stop-monitoring') {
      observer.disconnect();
      window.__quizToGoogleObserver = null;
      observedRoots = new WeakSet();
      if (poller !== null) clearInterval(poller);
      poller = null;
      if (timer !== null) clearTimeout(timer);
      if (videoNextRetryTimer !== null) clearTimeout(videoNextRetryTimer);
      videoNextRetryTimer = null;
      videoNextRetrySignature = '';
      videoCompletionClickedSignature = '';
      setStatus('Monitoring stopped.');
    }
    if (message?.type === 'start-monitoring') {
      if (!window.__quizToGoogleObserver) {
        observeAvailableRoots();
        window.__quizToGoogleObserver = observer;
        poller = setInterval(scan, 2000);
      }
      setStatus('Course helper is on for this tab.');
      scheduleScan();
    }
    if (message?.type === 'auto-skip-settings') {
      autoSkipLabs = message.autoSkipLabs !== false;
      autoSkipVideos = message.autoSkipVideos !== false;
      scheduleScan();
    }
    if (message?.type === 'scan-now') scheduleScan();
    if (message?.type === 'scan-first-question') {
      firstQuestionOnly = true;
      scheduleScan();
      setStatus('Testing with question 1 only…');
    }
    if (message?.type === 'apply-ai-answers') applyAnswers(message.answers);
    if (message?.type === 'ai-answer-timeout') {
      setStatus('Gemini did not return a matching answer sequence. Check its response and apply the answers manually.');
    }
    if (message?.type === 'ai-submit-status') {
      setStatus(message.submitted
        ? 'Prompt sent to Gemini.'
        : message.filled
          ? 'Prompt is in Gemini, but its send button was not found. Press Enter to send.'
          : 'Gemini opened, but its message box was not found or could not be filled. The prompt is copied; click the message box and press Ctrl+V.');
    }
  });

  setStatus('Watching this page for multiple-choice questions…');
  scheduleScan();
})();
