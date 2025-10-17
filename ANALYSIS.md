# Test Coverage and Tooling Assessment

## Current Automated Test Setup
- The repository ships only with `jest.e2e.config.js`, targeting `test/e2e/**/*.test.ts` and relying on `ts-jest` with a generous 120s timeout. There is no base Jest configuration for unit tests and no coverage collection settings are enabled.
- `npm run test:e2e` maps directly to this configuration. The default `npm test` script references `test/run-tests.sh`, but that script is absent, so the convenience entry point fails—an immediate tooling gap.
- The sole test, `test/e2e/backup-restore.e2e.test.ts`, spins up a Dockerized `mongo:4.4` instance via Testcontainers, seeds data, and then executes the compiled CLI (`npm run backup` / `npm run restore`). This provides a high-fidelity integration check that exercises backup/restore flows, preset usage, and metadata handling.
- Successful execution of the E2E suite requires Docker, the MongoDB Database Tools (`mongodump`, `mongorestore`) to be installed on the host, and network access for pulling the Mongo image. These external dependencies contribute to long setup times and make the suite unsuitable for fast feedback.

## Existing Coverage Strengths
- The end-to-end test validates the entire happy-path workflow, including preset-driven backups and basic failure handling (`--preset` not found).
- Because the test invokes the real CLI entry points, it implicitly verifies argument parsing, configuration loading, file I/O for metadata, and interaction with the backup/restore services against a live MongoDB instance.
- Testcontainers keeps the MongoDB test environment isolated and disposable, reducing the risk of polluting local databases.

## Coverage Gaps and Untested Core Flows
- **Configuration Validation and Persistence**: `Config` and `UpdateableConfig` classes rely on Zod schemas and filesystem writes, but there are no unit tests that confirm validation failures, default handling, or error logging for malformed configurations.
- **Prompt Flows (`PromptService`)**: Interactive logic spans ~700 lines with complex branching (time filters, preset management, restore selection). None of this is covered. Mocking `inquirer`, the logger spinner, `MongoDBService`, and `BackupService` would be required to isolate this logic.
- **Backup/Restore Services**:
  - `BackupService` and strategy selection (local vs SSH) lack unit tests to ensure the correct commands and arguments are assembled, especially for include/exclude modes and time-filter handling.
  - `RestoreService` has extensive namespace-mapping and error-path logic that is untested, including parsing of `mongorestore` output.
- **SSH Strategies and Infrastructure**:
  - `SshBackupStrategy`, `SshBackupRunner`, and `MongoDBService` tunnel handling are untested. These pieces are sensitive to filesystem state (private keys), environment configuration, and third-party libraries (`tunnel-ssh`).
  - Error handling branches (tunnel failures, credential fallbacks) are particularly at risk.
- **Utility Modules**: Helpers such as `parseMongoUri`, ObjectId/time helpers, and logging utilities have no direct coverage.
- **Entry Points and Yargs Parsing**: The CLI argument handling in `entrypoint/cli.ts` and `entrypoint/interactive.ts` is only implicitly exercised by the single e2e flow and lacks targeted tests for edge cases (invalid flags, missing presets, conflicting arguments).

## Mocking and Testability Considerations
- Many modules depend on `child_process` (`execSync`, `spawn`), direct filesystem access, and environment-level tools. Abstracting these dependencies behind injectable interfaces would simplify mocking.
- `PromptService` intertwines user prompts with side effects (e.g., reading collections via `MongoDBService`). Introducing lightweight wrappers for `inquirer` and spinner logging would allow deterministic unit tests.
- SSH-related code currently reads private keys from disk and opens real tunnels. Providing dependency injection points for filesystem and tunnel creation (or utilizing `jest.mock` with well-defined adapters) would make isolated tests feasible.

## Tooling and Complementary Approaches
- **Jest Unit Test Configuration**: Introduce a primary `jest.config.ts` (or extend the existing config) to cover `src/**/*.test.ts` with `ts-jest`, enable `testEnvironment: node`, and configure `moduleNameMapper` for the TS path aliases. This lays the groundwork for unit tests without affecting the e2e suite.
- **mongodb-memory-server**: Leveraging `mongodb-memory-server` (or its replica-set variant) could provide faster, dependency-light integration tests that still exercise MongoDB interactions. Caveats:
  - It downloads MongoDB binaries on first run, but removes the Docker dependency and accelerates startup compared to Testcontainers.
  - The CLI still invokes `mongodump`/`mongorestore`, so those binaries remain required. However, pairing memory-server as the Mongo instance with mocked child-process invocations would let us test surrounding logic without needing Docker.
  - For true end-to-end backups that rely on `mongodump` output, memory-server can serve as the Mongo target while keeping execution local.
- **Selective Mocking for CLIs**: For unit-level verification, mock `child_process` to assert that the right command arguments are produced, reserving real process execution for a smaller integration suite.
- **Script Tooling Fix**: Provide or replace the missing `test/run-tests.sh` script so `npm test` is useable (e.g., delegate to `npm run test:e2e` while supporting future unit-test orchestration).
- **Coverage Reporting**: Once unit tests exist, enable `collectCoverage` with sensible thresholds to monitor improvements.

## Recommended Next Steps
1. Add a base Jest configuration and restructure test scripts so unit tests can be added without touching the slow e2e flow.
2. Seed unit tests for deterministic components:
   - Config validation success/failure cases using fixture JSON files.
   - `BackupService` argument construction (with mocked strategy selector) and `RestoreService` namespace handling via mocked `spawn`.
   - Utility functions and `MongoDBService.buildMongoUri` edge cases.
3. Introduce adapter abstractions for `inquirer`, `child_process`, and SSH tunneling to enable mocking in upcoming tests.
4. Evaluate `mongodb-memory-server` as a replacement (or complement) for Testcontainers in integration tests to reduce runtime and external dependencies.
5. Restore the broken `npm test` entry point to make running the current suite straightforward for contributors and CI.
