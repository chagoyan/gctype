# GCType

Client-side, static Typing.com → Google Classroom auto-grader. Online migration of the local Flask app at `../typing-grader/`.

No backend, no server storage. CSV parsing, roster matching, and grade computation all run in the browser — the raw CSV and student names never leave the client. Deployed as a standalone Netlify site.

Full migration decisions: see `typing-autograder-online-migration-handoff.md`. Original Flask app spec: `../typing-grader/README.md` and `../typing-grader/PROJECT_SUMMARY.md`.

## Status

Scaffold only — porting in progress. See project memory `project_typing_auto_grader_tool` for the current step-by-step plan.

## Structure

- `index.html` — single-page shell (upload → preview → submit, plus assignment creation picker)
- `js/csvParser.js` — port of `csv_parser.py`
- `js/matcher.js` — port of `matcher.py` (includes the grading rule)
- `js/curriculum.js` — port of the `CURRICULUM` dict
- `js/auth.js` — Google Identity Services `initTokenClient` flow
- `js/classroomClient.js` — port of `classroom_client.py`, as client-side `fetch` calls
- `js/app.js` — view state management, replaces Flask routes
