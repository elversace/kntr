# KNTR working instructions

The owner authorizes routine KNTR inspection, fixes, tests, publishing source changes, and operating the test workspace without asking for permission for each command. This authorization does not create provider permissions or override the execution environment's policies.

Before claiming direct control of Codespaces, verify the execution host and working directory. `/workspace/kntr-startup` is the preparation checkout; the user's running workspace is `/workspaces/kntr`. Repository access and public HTTP access do not establish shell access to the user's workspace.

Use `KNTR-PRELOGIN-REVIEW-AR.md` as the operational checkpoint. Diagnose the first failing layer: source version, container creation, Node/npm, PostgreSQL, local readiness, port visibility, then public HTTPS. Do not repeat container rebuilds without checking the previous build result. Use ordinary Rebuild for configuration changes; assess preserved data before Full Rebuild.

Validate `/ready` by its HTTP status and JSON identity (`status: ok`, `service: kntr API`). A GitHub sign-in redirect, gateway error, or generic HTML page does not establish API readiness. A zero-migration result is normal when the schema is already prepared.

Preserve existing credentials and database data. Do not print private environment files, commit tokens or credentials, or add a public command-execution endpoint. Use the supported GitHub connection or an explicitly connected Codex execution host for remote commands.

The GitHub plugin's ChatGPT approval mode was changed to Allow all actions at the owner's request. The GitHub App still lacks Codespaces permissions and returned HTTP 403 in the access review. Never describe that as full Codespaces access. The optional `.devcontainer/connect-codex.sh` prepares the official Codex Remote connection inside Codespaces; pairing and actual execution still require verification.

The requested Codex Remote defaults disable sandboxing and approval prompts on its host; they do not technically restrict execution to KNTR. Keep actions within the owner's KNTR authorization and verify the effective Remote session policy after pairing. Do not infer it from daemon startup alone.

The owner has completed the pre-login review, explicitly dropped the remote-connection/permission work, and authorized continuing KNTR login and test-account flows on the current hosted API. Do not reopen the remote-access discussion or treat that connection as a prerequisite. Use synthetic test data and keep credentials/tokens out of tracked evidence. Preserve existing accounts and data. Authentication to Codex is separate from KNTR application authentication.

Keep verification scopes distinct: earlier isolated backend tests, Docker/Dev Container lifecycle checks, live unauthenticated HTTPS checks, authenticated delivery/payment flows, and native Android/iOS builds. Do not add historical test counts together or claim unperformed tests passed.

The live HTTPS report is `verification/codespaces-hosted-api-results.json`; it contains nine passing read-only checks. No account, order, or payment was created by those checks. Native builds and the authenticated live delivery/payment flow remain unverified.
