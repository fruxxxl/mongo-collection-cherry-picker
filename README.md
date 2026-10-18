[![E2E Tests](https://github.com/fruxxxl/mongo-collection-cherry-picker/actions/workflows/e2e.yml/badge.svg?branch=master)](https://github.com/fruxxxl/mongo-collection-cherry-picker/actions/workflows/e2e.yml)

# MongoDB Collection Cherry Picker 🍒

A CLI for developers who need selected MongoDB collections for a backup or another environment. Choose the collections interactively or reuse a preset in a script.

Backups can run through a direct connection or over SSH. Restore uses a direct MongoDB connection; SSH restore is not implemented. See the [backup strategies](src/modules/backup/strategies/) and [restore service](src/modules/restore/services/restore.service.ts).

**По-русски:** выборочный backup коллекций MongoDB и восстановление в другое окружение. Можно сохранить набор коллекций в пресете, чтобы повторять перенос. SSH поддерживается для backup; для восстановления нужно прямое подключение.

---

## ⚡️ Quickstart

```bash
npm ci
npm run build

# Interactive mode (recommended for most users)
npm run interactive:dev   # after build, for development
npm run interactive       # after build, for production

# CLI mode (for automation, CI, or scripting)
npm run backup -- --config=./myconfig.json --source=localDev --scope=all
npm run backup -- --config=./myconfig.json --preset=users_only
npm run restore -- --config=./myconfig.json --file=backup_2023-10-28_stagingServer.gz --target=localDev
```

- All CLI arguments must be passed after `--` (npm convention).
- For restore, you can use either `--file` or `--backupFile` (we're flexible like that).
- Use `--config=...` to specify a custom config file (highly recommended for tests and CI).

---

## ✨ Features

- **Selective Backups:** All, include, or exclude specific collections.
- **Direct Restores:** Restore through a direct MongoDB connection. The `--drop` option deletes matching target collections before restoring.
- **Multiple Connections:** Configure local or remote MongoDB connections; SSH execution is supported for backups.
- **SSH Backup:** Run `mongodump` on the remote host and stream the archive to a local file.
- **Interactive Mode:** User-friendly prompts, zero guesswork.
- **CLI Mode:** Scriptable, automatable, CI/CD-friendly.
- **Presets:** Save and reuse your favorite backup configs.
- **Metadata:** Every backup comes with a juicy JSON sidecar.
- **Custom Filenames:** Tweak your backup naming scheme.
- **Gzip Compression:** Because size matters.

---

## ⚙️ Configuration (`config.json`)

Place a `config.json` in your project root. All fields are validated at startup. Example:

```json
{
  "backupDir": "./backups", // (string, optional) Where to store backups. Default: './backups'
  "filenameFormat": "backup_{{datetime}}_{{source}}.gz", // (string, optional) Filename template. Default: 'backup_{{datetime}}_{{source}}.gz'
  "mongodumpPath": "mongodump", // (string, optional) Path to mongodump. Default: 'mongodump'
  "mongorestorePath": "mongorestore", // (string, optional) Path to mongorestore. Default: 'mongorestore'
  "connections": [
    {
      "name": "localDev", // (required) Unique name
      "uri": "mongodb://localhost:27017/", // (optional) Connection URI (preferred)
      "database": "devdb", // (required) Default DB
      // If no URI, use host/port/auth fields:
      "host": "localhost",
      "port": 27017,
      "username": "user",
      "password": "pass",
      "authenticationDatabase": "admin",
      "ssh": { // (optional) SSH tunnel
        "host": "ssh.yourserver.com",
        "port": 22,
        "username": "ssh_user",
        "privateKey": "~/.ssh/id_rsa",
        "passphrase": "hunter2",
        "password": "optional"
      }
    }
  ],
  "backupPresets": [ // (optional) Save your favorite configs
    {
      "name": "Core Staging Data", // (required)
      "sourceName": "localDev", // (required)
      "description": "Backup essential collections", // (optional)
      "selectionMode": "include", // 'all', 'include', or 'exclude'
      "collections": ["users", "products"], // (required for include/exclude)
      "queryStartTime": "2023-10-27T00:00:00Z", // (optional, ISO8601)
      "createdAt": "2023-10-27T10:30:00Z" // (required, auto-managed)
    }
  ]
}
```

**Field details:**
- `backupDir`: Where backup archives and metadata live. Default: `./backups`
- `filenameFormat`: Template for backup filenames. Placeholders:
  - `{{date}}`: Current date (DD-MM-YYYY)
  - `{{datetime}}`: Date and time (DD-MM-YYYY_HH-mm)
  - `{{source}}`: Name of the source connection
- `mongodumpPath`, `mongorestorePath`: Optional. Use system default if not set.
- `connections`: Array of connection configs. Each needs a unique `name` and a `database`. Use `uri` or host/port/auth fields. SSH is optional.
- `backupPresets`: Optional array of presets. Each needs a unique `name`, `sourceName`, `selectionMode`, and `createdAt`. `collections` is required for `include`/`exclude` modes. `queryStartTime` is optional (ISO8601).

---

## 🖥️ Usage

### Interactive Mode

- Run `npm run interactive:dev` (for dev) or `npm run interactive` (for production) after building the project.
- You'll get a friendly menu for backup, restore, and preset management. No need to remember any flags—just follow the prompts!

### CLI Mode

- For scripting, automation, or if you just love flags:

```bash
npm run backup -- --config=./myconfig.json --source=localDev --scope=include --collections=users,orders
npm run backup -- --config=./myconfig.json --preset=users_only
npm run restore -- --config=./myconfig.json --file=backup_2023-10-28_stagingServer.gz --target=localDev
npm run restore -- --config=./myconfig.json --backupFile=backup_2023-10-28_stagingServer.gz --target=localDev --drop
```

- All CLI arguments go after `--`.
- Both `--file` and `--backupFile` are supported for restore (because why not?).
- `--config=...` lets you use any config file you want.

---

## 💾 Backup Metadata

Every backup archive (e.g., `backup_2023-10-28_stagingServer.gz`) comes with a JSON metadata file (e.g., `backup_2023-10-28_stagingServer.gz.json`). Example:

```json
{
  "source": "stagingServer",
  "database": "stagingdb",
  "selectionMode": "include",
  "includedCollections": ["users", "products"],
  "timestamp": 1698480000000,
  "date": "2023-10-28T08:00:00.000Z",
  "archivePath": "backup_2023-10-28_stagingServer.gz",
  "presetName": "Core Staging Data",
  "queryStartTime": "2023-10-27T00:00:00Z"
}
```

---

## 🧑‍💻 Scripts (from package.json)

- `npm run interactive` — Start interactive mode (recommended for most users)
- `npm run backup -- ...` — Run a backup via CLI (see above for args)
- `npm run restore -- ...` — Run a restore via CLI
- `npm run build` — Compile TypeScript
- `npm test` — Run all tests
- `npm run test:e2e` — Run end-to-end tests

> Pro tip: You can always use `npx ts-node` for direct dev runs, or pass `--config=...` to use a custom config file.

---

## 🤝 Contributing

PRs, issues, and stars are always welcome! If you spot a bug, want a feature, or just want to say hi—open an issue or PR.

---

## 🍒 Why "Cherry Picker"?

Because sometimes you only want the juiciest collections. And who doesn't love a good cherry?

---

## 📄 License

MIT. Use it, fork it, break it, fix it. Just don't blame us if your database grows wild.
