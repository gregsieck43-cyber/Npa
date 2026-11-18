# Original DSH runtime formatter

This fixture uses DSH host exports, `defineTool`, Schemastery configuration, tool registration and effect disposal. It has no `npn` declaration and no npm dependencies. Its source was authored for NPN-Gamma and does not contain upstream plugin implementation code.

Install this directory, approve the displayed artifact digest, then enable it. The `dsh_clean` operation normalizes newlines and trims text. Configuration defaults are `uppercase: false` and `prefix: ""`. Change configuration while disabled, approve the new digest, then enable again.

NPN supports a restricted runtime adapter rather than the entire DSH host. This fixture requests only the text tool service. It cannot access files, subprocesses, network, credentials or the approval kernel.
