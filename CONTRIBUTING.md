# Contributing to NPA

Thanks for helping improve NPA. The project is intentionally single-user,
local-only, and offline-first; proposed changes should preserve explicit
approval gates and auditable side effects.

## Development setup

1. Use Node.js `24.18.x`.
2. Run `npm ci` from the repository root.
3. Start the frontend with `npm run dev`, or build and run the local server with
   `npm run build` followed by `npm start`.
4. Run `node code-cli.js --self-test` before opening a pull request.

## Pull requests

- Explain the user-facing behavior and the public seam being changed.
- Keep commits focused and avoid unrelated formatting or generated files.
- Add or update tests for behavior changes. Prefer the existing server,
  frontend, API smoke, security, and responsive UI seams.
- Update the relevant public documentation for material architecture or
  verification changes.
- Do not add credentials, local data, logs, caches, private agent rules,
  downloaded runtimes, or release binaries.

## Required checks

```powershell
npm run typecheck
npm test
npm run test:ui
```

Release maintainers should also build the Windows package before running the
release gate:

```powershell
npm run package:win
npm run release:gate
```

The real wall-clock 72-hour soak is a separate release qualification step and
is not implied by the accelerated fake-clock test.

## Design and licensing

Keep the existing quiet task-workbench information architecture and responsive
constraints. New code is licensed under Apache-2.0 unless a file says
otherwise; preserve third-party notices and do not reuse external logos,
screenshots, or source code without checking their license and trademark
terms.
