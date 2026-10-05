# Security Policy

## Reporting a vulnerability

Please do **not** disclose security vulnerabilities in a public GitHub issue.

### Preferred: GitHub private vulnerability reporting

Use the repository's **Security** tab and choose **Report a vulnerability** when private vulnerability reporting is enabled. The report is visible only to repository maintainers.

Include, when possible:

- a clear description of the issue;
- affected component or file;
- steps to reproduce;
- expected and observed behavior;
- potential impact;
- any suggested fix or mitigation.

If private vulnerability reporting is not available, open a public issue only to request a private contact channel. Do not include vulnerability details, proof-of-concept code, credentials or exploit instructions in that issue.

## Primary supported scope

The main supported security surface of PeerSync by Nickston currently includes:

- the portable Windows shell in `apps/portable-python`;
- the shell/Core IPC boundary;
- the portable P2P core in `packages/core/src/portable`;
- the file-transfer engine in `packages/drive`;
- pairing, remembered-device and transfer-admission logic used by the portable client;
- the portable build, update and integrity-validation path.

Reports affecting transport, protocol compatibility and persistent state are within the supported scope.

## Out of scope

The following are generally outside the scope of this project's own security fixes:

- vulnerabilities that exist solely in third-party dependencies and should be fixed by their upstream maintainers;
- issues that require physical access to an already unlocked device and do not cross an existing trust boundary;
- social engineering of users;
- reports that contain no reproducible security impact.

## Responsible disclosure

Please allow maintainers reasonable time to investigate and prepare a fix before publishing technical details. Coordinate with affected dependency maintainers when appropriate.
