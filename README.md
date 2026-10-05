# Quiz to Gemini (Firefox)

A temporary Firefox extension for extracting Google Skills-style multiple-choice quizzes, asking Gemini for answers, and applying the returned options to the page.

## Install temporarily

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Choose **Load Temporary Add-on…**.
3. Select this folder's `manifest.json`.
4. Open the course page and turn on **Course helper**. Use the **Auto-skip Labs** and **Auto-skip Video lectures** switches to choose which course activities to skip.

Turn **Course helper** off to stop monitoring. Browser-internal pages cannot be inspected.

## Quiz handling

The scanner looks for a visible quiz section and extracts questions and choices from radio buttons, checkboxes, ARIA controls, and nearby question text. It follows open shadow roots and watches for dynamic page updates. If the page's numbered-question count exceeds the extracted count, it waits rather than sending an incomplete list. Image-only or canvas-only questions are not readable by this version.

Each extracted question is tagged `SQ.n` for a single-answer radio question or `MQ.n` for a multiple-answer checkbox question. The Gemini prompt asks it to return one line per question with the same tag, for example:

```text
SQ.1: 2
MQ.2: 1,3
SQ.3: 4
```

The extension checks the answer count and tag against each question before selecting anything. It selects one option for `SQ` questions and all returned options for `MQ` questions, then submits the attempt.

After submission, it compares the score with that quiz page's displayed passing score. A passing or already-completed quiz advances with **Next**. If the attempt fails, it records questions identified as incorrect and requests corrected answers for the retake in the same Gemini conversation. It stops for manual review when it cannot confidently match the questions, answers, score, or page controls.

## Course activity skipping

With the corresponding switches on, the helper skips detected lab and video activities using **Next**. For video pages where **Next** is unavailable, it looks for **Mark as completed**, clicks it, and continues checking for **Next**. It checks visible page content and open shadow roots for quiz, lab, and video controls.

Gemini may require sign-in or may not be available in your region.

