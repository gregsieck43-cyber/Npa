# Contributing to NPN-Gamma Code

Follow the Windows x64 setup in [README.md](README.md). Run checks from the repository root after setup. Close your test desktop and stop its backend before running the checks serially. During concurrent desktop and IDE tests, the Windows resource guard has reported Win32 error 5 while attaching a process to its Job.

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:frontend
npm.cmd run test:smoke
```

Run `npm.cmd run build` after modifying TypeScript. `npm.cmd test` exercises the compiled backend tests. Optional host tests need the IDE installation described in the README. REA tests use a separately installed, explicitly enabled REA CLI. Keep tests local and use synthetic model credentials. Report the command, version and pass/fail/skip counts.

Maintainers preparing a local Windows package must first build the project and prepare the branded IDE. Set `NPN_RELEASE_NAME` to a fresh versioned name such as `NPN-Gamma-0.0.1`, then run `npm.cmd run package`. The packager refuses existing output directories and verifies the recovery archive. Audit the new package and all nested archives before distributing it.

Keep local data, credentials, logs and generated packages out of contributions. Preserve third-party notices. Use [private reporting](SECURITY.md) for security issues.
