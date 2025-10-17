# CLI & Interactive Runtime Inventory

## Layered Component Overview

```
Entrypoints (src/entrypoint/*.ts)
   │
   ├─ Mode Orchestrators
   │    • CLIMode (modes/cli-mode.ts)
   │    • InteractiveMode (modes/interactive-mode.ts)
   │
   ├─ Controllers (modules/*/controllers)
   │    • BackupController
   │    • RestoreController
   │    • PresetController (interactive only)
   │
   ├─ Domain Services (modules/*/services)
   │    • BackupService → BackupStrategySelector → Local/Ssh strategies → mongodump
   │    • RestoreService → mongorestore
   │    • PromptService (wraps Inquirer + MongoDBService + BackupService)
   │
   └─ Infrastructure & Utilities (src/infrastructure, src/utils)
        • Logger (spinner-aware logging)
        • MongoDBService (direct + SSH tunnel connections)
        • File/time/ObjectId helpers used by strategies
```

The entrypoints wire configuration loading, logging, and controller/service instances. Controllers coordinate user intent (args or prompts) with the lower-level services that actually execute mongodump/mongorestore or update configuration.

## CLI Mode Flow (src/entrypoint/cli.ts → modes/cli-mode.ts)

### Startup
- `entrypoint/cli.ts` resolves a `config.json` path and instantiates `CLIMode`.
- `CLIMode` constructor:
  - Instantiates a scoped `Logger` and parses `process.argv` into `CommandLineArgs`.
  - Loads & validates config via `Config`, storing `AppConfig`.
  - Creates `BackupService`, `MongoDBService`, `RestoreService` with prefixed loggers.
  - Constructs controllers:
    - `BackupController(config, {} as PromptService, mongoService, backupService, logger)`. PromptService placeholder is unused in CLI flows.
    - `RestoreController(config, backupService, {} as PromptService, restoreService, logger)`.

### Argument Parsing Highlights
`parseCommandLineArgs` handles long-form flags, allowing `--config` override before validation. Key mappings:

| Flag | Field | Effect |
| --- | --- | --- |
| `--backup` / `--action=backup` | `mode="backup"` | Select backup workflow |
| `--restore` / `--action=restore` | `mode="restore"` | Select restore workflow |
| `--source=name` | `source` | Source connection name |
| `--scope=all|include|exclude` | `backupMode` | Desired collection mode |
| `--collections=a,b` | `collections[]` | Target collections list |
| `--preset=name` | `preset` | Direct preset run |
| `--file=path` / `--backupFile=path` | `backupFile` | Backup file for restore |
| `--target=name` | `target` | Target connection name |
| `--drop` | `drop=true` | mongorestore `--drop` option |
| `--since-time[=value]` | `sinceTime` | Relative/ISO filter (include mode only) |

Validation ensures required flags are present per mode and terminates the process with helpful logging on error.

### Execution Paths
- `run()` switches on `args.mode`.
  - **Backup** (`backupFromArgs`):
    1. If `preset` is supplied, `BackupController.useBackupPreset` fetches preset config, resolves collections/time filter, and invokes `BackupService.createBackup`.
    2. Otherwise expects `source` + optional `backupMode`, `collections`, `sinceTime`.
    3. Parses `sinceTime` using `date-fns` helpers, enforcing `include` mode with exactly one collection.
    4. Delegates to `BackupController.backupFromArgs`, which:
       - Resolves actual collection set via `getActualBackupParams` (may inspect MongoDB via `MongoDBService`).
       - Calls `BackupService.createBackup` and writes metadata `.json` next to archive.
       - Ensures `MongoDBService` connection cleanup and spinner termination.
  - **Restore** (`restoreFromArgs`):
    1. Requires `backupFile` and `target` flags.
    2. Builds restore options (`drop` flag) and invokes `RestoreController.runRestore`.
    3. Controller loads backup metadata via `BackupService`, verifies archive presence, then calls `RestoreService.restoreBackup`.

Both paths rely on spinner-aware logging to communicate progress and errors, exiting the process on fatal issues.

## Interactive Mode Flow (src/entrypoint/interactive.ts → modes/interactive-mode.ts)

### Startup & Dependency Graph
- `entrypoint/interactive.ts` instantiates `InteractiveMode` with the default config path.
- `InteractiveMode` constructor composes:
  - `Config` → validated `AppConfig`.
  - `UpdateableConfig` wrapping `Config` for persistent preset mutations.
  - Shared services: `BackupService`, `MongoDBService`, `RestoreService`.
  - `PromptService` with references to `UpdateableConfig`, `BackupService`, `MongoDBService`, and its own `Logger`.
  - `Controller` instances using shared services:
    - `BackupController(appConfig, promptService, mongoService, backupService, logger)`.
    - `RestoreController(appConfig, backupService, promptService, restoreService, logger)`.
    - `PresetController(updateableConfig, promptService, logger)`.

### Interactive Loop
- `run()` maintains a loop until the user selects "Exit" or cancels continuation.
- Actions fetched via `PromptService.askStartAction()`:
  - **Backup:** `BackupController.backupDatabase()` orchestrates prompts for source, collection mode, optional time filter, runs backup, and writes metadata.
  - **Restore:** `RestoreController.restoreDatabaseInteractively()` prompts for backup file, target connection, drop option, then delegates to `runRestore`.
  - **Preset Create:** `PresetController.createPresetInteractively()` collects preset details, persists via `UpdateableConfig`, optionally runs preset immediately through `BackupController.useBackupPreset`.
  - **Preset Manage:** `PresetController.managePresetsFlow()` opens a manage menu via `PromptService`, supporting run/view/delete flows; optionally chains into backup execution.
- After each handler, `PromptService.askContinueAction()` determines whether to loop.
- Errors during action execution are caught, logged, and break the loop gracefully.

## Controllers & Service Wiring

### BackupController
- Inputs: `AppConfig`, `PromptService` (interactive only), `MongoDBService`, `BackupService`, `Logger`.
- Responsibilities:
  - **Interactive backup**: gather user intent, fetch available collections, compute effective include/exclude sets, run `BackupService.createBackup`, write metadata.
  - **Preset backup**: load preset definitions, validate source connection, parse optional time filter, compute effective collection handling, execute backup & metadata.
  - **CLI backup**: similar to presets but driven by parsed args.
  - **Collection resolution**: `getActualBackupParams` inspects MongoDB to convert "include" lists into the actual exclude set required by mongodump, handles time-filter enforcement, and falls back intelligently on errors.
  - Ensures `MongoDBService` connections are closed after each run.

### RestoreController
- Inputs: `AppConfig`, `BackupService`, `PromptService`, `RestoreService`, `Logger`.
- Responsibilities:
  - Load backup metadata and print human-readable summaries.
  - Validate target connection/backup availability and map namespaces when restoring into a different database.
  - Delegate to `RestoreService.restoreBackup` with `drop` option handling.
  - Interactive flow reuses PromptService to capture user selections.

### PromptService
- Inputs: `UpdateableConfig`, `BackupService`, `MongoDBService`, `Logger`.
- Responsibilities:
  - All user prompting via Inquirer for backup/restore/preset flows.
  - Fetch collection lists on demand via `MongoDBService` (with spinner feedback).
  - Display metadata summaries using `BackupService` helpers.
  - Manage preset lifecycle questions (create, view, delete, run).
  - Provide optional time-filter selection leveraging date-fns utilities.

### PresetController
- Inputs: `UpdateableConfig`, `PromptService`, `Logger`.
- Responsibilities:
  - Manage interactive preset creation and persistence by mutating `UpdateableConfig.parsed.backupPresets` and calling `update()`.
  - Provide management menu to view, delete, or trigger presets.

## Domain Services

### BackupService
- Wraps `BackupStrategySelector` to choose between `LocalBackupStrategy` and `SshBackupStrategy` based on `ConnectionConfig.ssh`.
- Produces backup archive paths using `Dump` domain helper.
- Exposes metadata utilities (`loadBackupMetadata`, `getBackupFiles`).

### Backup Strategies & Dump Helper
- `Dump.buildArgs()` constructs mongodump arguments.
  - Handles direct URI vs host/port credentials.
  - Applies include/exclude collection flags.
  - Injects ObjectId-based time filter query when applicable, using `objectIdFromTimestamp`.
  - Ensures `--gzip` plus `--forceTableScan` for full dumps.
- `LocalBackupStrategy` spawns `mongodump` locally, streaming output to a `.gz` archive and logging progress.
- `SshBackupStrategy` uses `SshBackupRunner` to execute `mongodump` remotely via SSH, streams archive bytes back, and renames temp files on success.
- `SshBackupRunner` manages SSH authentication, command quoting, piping, and error handling via `node-ssh`.

### RestoreService
- Builds `mongorestore` argument list (URI/host, namespace mapping, archive path, gzip, drop option).
- Currently only fully supports local execution; SSH mode logs a warning placeholder.
- Spawns child process, streams stdout/stderr through Logger, and parses output to summarize restored and failed document counts.

## Configuration & Types

- `Config` loads JSON from disk, validates using zod schema (`AppConfigSchema`), and exposes `parsed` `AppConfig`.
- `UpdateableConfig` wraps a `Config` to support writing changes (e.g., new presets) back to the same file.
- Type definitions in `src/types/mixed.ts` unify `ConnectionConfig`, `BackupPreset`, `BackupMetadata`, and `AppConfig` across modules.
- Zod schemas enforce defaults for `backupDir`, `filenameFormat`, `mongodumpPath`, and `mongorestorePath`, ensuring controllers/services operate on normalized config objects.

## Infrastructure & Cross-Cutting Concerns

### Logger (`src/infrastructure/logger.ts`)
- Centralized logging with prefixed context, colorized output, and spinner control via `ora`.
- Provides `startSpinner`, `updateSpinner`, success/fail persistence, warnings, error logging with optional stack traces when debug enabled.
- Utilities like `snippet` and `logRaw` support rendering shell commands and metadata blocks.

### MongoDBService (`src/infrastructure/mongodb.service.ts`)
- Manages MongoDB connections for listing collections and other prompt-time operations.
- Supports direct URI/host connections and SSH tunnels via `tunnel-ssh`, translating connection configs into temporary local URIs.
- Ensures resources are closed after operations to avoid leaking clients or tunnel servers.
- Used primarily by `PromptService` and `BackupController` for metadata gathering.

### Utility Modules
- `formatted-timestamp`, `format-filename`, `object-id-from-timestamp`, `parse-mongo-uri` provide reusable helpers for naming archives, generating time-based ObjectIds, and interpreting connection URIs.
- These utilities are leveraged by the dump domain logic and MongoDB/SSH services to keep controller code declarative.

## Runtime Data Flow Summary

```
CLI Entrypoint          Interactive Entrypoint
        │                          │
        ▼                          ▼
    CLIMode.run()            InteractiveMode.run()
        │                          │
 ┌─────┴─────┐               ┌─────┴─────┐
 │ parse args│               │ prompt loop│
 └─────┬─────┘               └─────┬─────┘
       │                            │
   (mode switch)             (action selection)
       │                            │
  BackupController              BackupController
       │                            │
   ┌───┴─────────────┐        ┌──────┴────────────┐
   │ getActualBackup │<──────▶│ PromptService.ask* │
   └───┬─────────────┘        └──────┬────────────┘
       │                            │
  BackupService.createBackup   (may reuse MongoDBService for data)
       │                            │
BackupStrategySelector           RestoreController / PresetController
       │                            │
 LocalBackupStrategy / SSHBackupStrategy   │
       │                            │
   Dump.buildArgs()               BackupService / RestoreService
       │                            │
 mongodump (child process)      mongorestore (child process)
       │                            │
 Metadata (.json) written        Configuration updates (presets)
```

This flow emphasizes that both modes converge on the same controllers and services—the difference lies entirely in how user intent is captured (command-line arguments vs. interactive prompts).

## Key Takeaways
- Controllers are thin orchestrators; heavy lifting is done by services and infrastructure helpers.
- Both CLI and interactive modes share the same backup/restore pipelines, ensuring feature parity.
- Prompt-related dependencies (e.g., `PromptService`) are only fully wired in interactive mode; CLI mode stubs them out because controllers don’t touch prompt methods during non-interactive execution.
- Logging and connection management are centralized in infrastructure classes, enabling consistent UX (spinners, colored output, resource cleanup) across flows.
