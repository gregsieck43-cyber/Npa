# Security Policy

NPN-Gamma Code is a single-user, local-first application. It can run model-driven file,
terminal, Git, network, connector, and credential-adjacent workflows, so a
local vulnerability may still create meaningful side effects.

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. Use GitHub's
private [Security Advisories](https://github.com/gregsieck43-cyber/Npa/security/advisories/new)
to report it. Include a short reproduction, affected version or commit, and a
safe proof of impact. Do not include API keys, connector secrets, local data,
logs, or personal paths in the report.

If private reporting is unavailable, open a minimal issue asking for a private
contact channel without attaching sensitive details.

## Scope and response

Reports involving path traversal or junction escapes, SSRF and redirects,
command authorization, secret redaction, request identity, local
context storage, crash recovery, or effect replay are especially useful. The
maintainer will acknowledge a report when practical, reproduce it locally,
publish a regression test where safe, and document the mitigation.

## Local secret handling

Never commit `.env` files, `data/`, connector keys, logs, downloaded runtimes,
or generated release output. Rotate any credential that may have been exposed
before sharing diagnostic material.
