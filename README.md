# Quiz to Gemini (Firefox)

A small Firefox extension that watches the current page for multiple-choice questions. When it finds them, it extracts the question text and option labels, copies the formatted prompt, opens Gemini, and tries to fill and submit its message box:

> Give me answers for these questions in this format: Just give me the question option numbers in sequential order without using question numbers, just present it like 1 2 3 4 5.

## Install temporarily

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Choose **Load Temporary Add-on…**.
3. Select this folder's `manifest.json`.
4. Open the course page and switch **Course helper** on. Use the **Auto-skip** switches to choose whether labs and video lectures should be skipped.

Turn **Course helper** off to stop it. While active, it can skip detected lab and video activities with their Next control and continue across page navigations until it detects a quiz. Quizzes from the same course tab continue in the same Gemini conversation. Browser-internal pages cannot be inspected.

## Current scope

The scanner looks for a visible quiz section, then gathers question containers from radio inputs, ARIA radio groups, or nearby question text. It follows open shadow roots and observes dynamic page updates. Image-only or canvas-only questions are not readable by this version.

After copying the preprompt and questions, it opens Gemini, fills and submits the prompt, then watches for a plain numeric answer line matching the quiz length. It copies that line, returns to the quiz tab, selects the options, and submits the attempt. It reports the score and the page's passing threshold. A score at or above the threshold clicks Next; a score below the threshold is recorded and retaken in the same Gemini conversation with the missed question text. The extension stops for manual review if it cannot detect a matching answer, score, missed questions, or page controls. Gemini may require you to sign in or may not be available in your region.

The extension background console logs the exact normalized prompt and its character count for comparing the copied text with a manual prompt.

