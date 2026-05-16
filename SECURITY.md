# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this package, please **do not open a public GitHub issue**.

Email **security@axumquant.com** with:

1. A description of the vulnerability
2. Steps to reproduce
3. The affected version(s)
4. Any potential impact you've identified

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation within 14 days for high-severity issues.

## Scope

This package stores audio frames in IndexedDB encrypted with AES-GCM-256. Security-relevant areas:

- **Key management** — keys are persisted in IndexedDB under a configurable store name. Bugs that leak the key, fail to rotate, or allow downgrade to plaintext are in scope.
- **Crypto strength** — the algorithm is AES-GCM-256 via Web Crypto. Reports of incorrect IV reuse, nonce collisions, or downgrade paths are in scope.
- **Cross-origin leakage** — IndexedDB is scoped to the extension origin. Bugs that cause writes/reads from another origin are in scope.
- **Disk persistence on shared computers** — the encryption protects against casual disk inspection. The threat model does NOT cover a fully-compromised local user (the key is reachable to anyone with code-execution in the extension context).

Out of scope:

- Web Crypto API bugs themselves (report to the browser vendor)
- IndexedDB platform bugs (report to the browser vendor)
- Misuse by consumers (e.g., passing the decrypted payload to a third party after `replay()`)
