# Validation record

2026-09-19

- One executable test file: `tests/L1-flow.spec.ts`.
- No duplicate functional specification.
- Page-object classes are contained in the single L1 specification.
- Headed, maximized Chromium and trace recording remain enabled.
- Exact empty-state requirement: eight visible `//div[@title='No Event Available']` matches.
- Fast-path live measurement completed 22 confirmed `False Activity` terminations in about one minute before the continuously replenishing UAT run was stopped.
- Missing action choices are detected immediately; termination still requires a fresh confirmation toast and completion of the originally clicked action.
- The consolidated `L1-flow.spec.ts` attaches every Live View screenshot to the report using the detected Unit ID.
- The Playwright project name was removed, so reports no longer display `uat-l1-chromium`.
- The latest completed run produced an 18,806,248-byte `trace.zip` and a 1,310,364-byte full-run `video.webm`; both are attached in the HTML report.
- Video recording is always enabled at the configured 1920×1080 size.
