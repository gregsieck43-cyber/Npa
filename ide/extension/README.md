# NPN Gamma IDE extension

Native VS Code / Code - OSS integration with the independent NPN backend. Bundled with the NPN local Windows editor; not published to a marketplace.

Native file editing, save, search, JS/TS services and project terminals do not create Agent tasks or call a model. The NPN secondary sidebar connects the original Chat/Work services: selected code context, explicit goals and budgets, task controls, exact tool approval/denial, native file Diff, retained requests and traces. Unsaved editor coordination and file-version checks reduce stale Agent overwrites; they are not OS locks or a hostile-plugin sandbox.

Use **NPN: Open Project** to explicitly choose a local F: project. A project outside the installation is authorized only through an explicit project action, not a background refresh. For a folder opened through the host's File menu, use **NPN: Connect Current Project** and confirm its exact root. The desktop's Code view and standalone `NPN-IDE.cmd --workspace` use the same persistent project registration. Model tools still require the original backend permissions and approval.

Set `npn.dataDirectory` to the explicit NPN data folder if installing the VSIX in another supported local editor. No API key or token belongs in this setting. Workspace Trust stays enabled; starting/resuming execution requires a trusted project. Remote SSH/WSL and the complete editable Prompt/Request Studio are not implemented in this slice. Native editor actions and other extensions remain outside the NPN tool Gateway.
