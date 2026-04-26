# Budget Buddy (Android-ready PWA)

An **offline-first budgeting app** you can run on your Android phone as an **installed web app** (PWA).

## Features (MVP)

- Manual expense entry (amount, date, category, merchant, note)
- Receipt capture on Android (camera) + **on-device OCR** (Tesseract.js loaded from CDN)
- Offline storage using **IndexedDB** (data stays on your device)
- Dashboard (month-to-date spending + recent expenses)
- Suggestions tab with simple cost-cut heuristics (budget pacing, top categories/merchants, recurring-like spending)
- Export expenses to CSV

## Run locally

If you have Python 3 installed:

```bash
python3 -m http.server 5173
```

Then open:
- `http://localhost:5173`

## Install on Android

- Open the app URL in **Chrome** on your phone
- Tap the menu (⋮) → **Add to Home screen** / **Install app**

## Notes

- Receipt OCR runs locally in your browser. First run may be slower while the OCR engine downloads.
- This MVP is single-device. If you want multi-device sync, we can add an optional backend later.

