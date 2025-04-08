# MongoDB Collection Cherry Picker 🍒

A powerful CLI tool for managing MongoDB database backups with fine-grained collection selection, preset management, and SSH support.

## 🚀 Overview

MongoDB Collection Cherry Picker allows you to easily create and restore database backups with precise control over which collections to include or exclude. It supports both local and remote MongoDB instances (via SSH tunnel), provides interactive and non-interactive modes, and allows saving common configurations as presets, making it suitable for both manual operations and automated scripts.

## ✨ Features

-   💾 **Selective Backups:** Create MongoDB backups choosing `all` collections, `including` specific ones, or `excluding` specific ones.
-   🔄 **Flexible Restores:** Restore databases from backup archives.
    -   Optionally drop existing collections in the target database before restore.
    -   Restore across different databases (e.g., production backup to staging database).
-   🔌 **Multiple Connections:** Manage configurations for various MongoDB instances (local, remote, different auth).
-   🔒 **SSH Tunnel Support:** Perform backups and restores on remote MongoDB instances accessible only via SSH.
-   🖥️ **Interactive Mode:** User-friendly prompts guide you through backup, restore, and preset management.
-   🤖 **Non-Interactive Mode:** Use command-line arguments for automation and scripting.
-   📋 **Presets:** Define, save, and reuse common backup configurations (source, collections, mode).
-   📝 **Metadata:** Each backup archive (`.gz`) includes a companion JSON file (`.gz.json`) detailing the backup parameters (source, database, collections included/excluded, mode, timestamp).
-   📄 **Customizable Filenames:** Configure the naming format for backup files.
-   🗜️ **Gzip Compression:** Backups are automatically compressed.

Demo video:
[![Watch the video](https://img.youtube.com/vi/_wcxIeL43xk/0.jpg)](https://youtu.be/_wcxIeL43xk?si=GsXqrSNrsxDtTtKi)

## 📥 Installation

```bash
# Clone the repository (if you haven't already)
# git clone <repository-url>
# cd mongo-collection-cherry-picker

# Install dependencies
npm install

# Compile TypeScript (optional, for running with node)
npm run build
```

## ⚙️ Configuration (`config.json`)

Create or modify the `config.json` file in your project root:

```json
{
  "backupDir": "./backups", // Directory to store backup files
  "filenameFormat": "backup_{{date}}_{{source}}.gz", // Format for backup filenames. Placeholders: {{date}}, {{source}}
  "mongodumpPath": "mongodump", // Optional: Path to mongodump executable
  "mongorestorePath": "mongorestore", // Optional: Path to mongorestore executable
  "connections": [
    {
      "name": "localDev", // Unique name for the connection
      "uri": "mongodb://localhost:27017/", // MongoDB connection URI (preferred)
      "database": "devdb" // Default database for this connection
    },
    {
      "name": "stagingServer",
      "uri": "mongodb://user:pass@remote.host:27017/stagingdb?authSource=admin", // URI for the remote DB
      "database": "stagingdb", // Database name (required if not in URI for some operations)
      "ssh": { // SSH Tunnel Configuration
        "host": "ssh.yourserver.com", // SSH host
        "port": 22,                   // SSH port
        "username": "ssh_user",       // SSH username
        "privateKey": "~/.ssh/id_rsa" // Path to your SSH private key (~/ is expanded)
        // "passphrase": "your_key_passphrase" // Optional: if your key is protected
      }
    },
    {
      "name": "prodReadOnly",
       // Example without URI - using host/port/auth
      "host": "prod.db.internal",
      "port": 27017,
      "database": "production",
      "username": "readonly_user",
      "password": "secure_password",
      "authenticationDatabase": "admin"
    }
    // Add more connections as needed
  ],
  "backupPresets": [ // Optional: Define reusable backup configurations
    {
      "name": "Core Staging Data", // Unique name for the preset
      "sourceName": "stagingServer", // Name of the connection to use
      "description": "Backup essential collections from staging",
      "selectionMode": "include", // 'include', 'exclude', or 'all'
      "collections": [ // Required for 'include' and 'exclude' modes
        "users",
        "products",
        "orders"
      ],
      "createdAt": "2023-10-27T10:30:00Z" // Managed by the tool
    },
    {
      "name": "Full Staging Without Logs",
      "sourceName": "stagingServer",
      "selectionMode": "exclude",
      "collections": ["logs", "audit_trails"],
      "createdAt": "2023-10-27T11:00:00Z"
    }
  ]
}
```

**Configuration Fields:**

*   `backupDir`: Path where backup archives (`.gz`) and metadata (`.gz.json`) files are stored.
*   `filenameFormat`: Template for naming backup files.
    *   `{{date}}`: Replaced with the current date (YYYY-MM-DD).
    *   `{{source}}`: Replaced with the `name` of the source connection.
*   `mongodumpPath`, `mongorestorePath`: Optional: Specify the full path to the executables if not in system PATH.
*   `connections`: Array of MongoDB connection configurations.
    *   `name`: Unique identifier.
    *   `uri`: MongoDB connection string (recommended). Takes precedence over host/port/auth fields.
    *   `database`: Target database name.
    *   `host`, `port`, `username`, `password`, `authenticationDatabase`/`authSource`: Used if `uri` is not provided.
    *   `ssh`: Optional object for connections requiring an SSH tunnel (`host`, `port`, `username`, `privateKey`, `passphrase`).
*   `backupPresets`: Optional array of predefined backup configurations.
    *   `name`: Unique identifier.
    *   `sourceName`: The `name` of the connection to use.
    *   `selectionMode`: `'include'`, `'exclude'`, or `'all'`.
    *   `collections`: Array of collection names (used for `include`/`exclude`).
    *   `createdAt`: Timestamp (managed by the tool).

## 🖥️ Usage

Run the tool using `ts-node` (for development) or `node` (after building).

```bash
# Using ts-node
npx ts-node src/main.ts [arguments]

# Using compiled code
node dist/main.js [arguments]
```

### Interactive Mode

Start the tool without arguments for a guided experience:

```bash
npx ts-node src/main.ts
# or
node dist/main.js
```

The menu allows you to:
1.  Create a backup (selecting connection, mode, collections).
2.  Restore from a backup (selecting backup file, target connection, options like `--drop`).
3.  Create backup presets.
4.  Manage (view/delete) existing presets.

### Non-Interactive Mode

Use command-line arguments for automation:

```bash
# Backup all collections from 'localDev'
node dist/main.js --mode backup --source localDev --backupMode all

# Backup specific collections ('users', 'orders') from 'stagingServer' (via SSH)
node dist/main.js --mode backup --source stagingServer --backupMode include --collections users,orders

# Backup all collections EXCEPT 'logs' from 'stagingServer'
node dist/main.js --mode backup --source stagingServer --backupMode exclude --collections logs

# Run a predefined backup preset
node dist/main.js --mode backup --preset "Core Staging Data"

# Restore a backup file to 'localDev', dropping target collections first
node dist/main.js --mode restore --backupFile ./backups/backup_YYYY-MM-DD_stagingServer.gz --target localDev --drop
```

## 💾 Backup Metadata (`<backup_file_name>.gz.json`)

Each backup archive (e.g., `backup_2023-10-28_stagingServer.gz`) has a corresponding JSON metadata file (e.g., `backup_2023-10-28_stagingServer.gz.json`).

```json
{
  "source": "stagingServer",       // Name of the source connection
  "database": "stagingdb",         // Name of the database backed up
  "includedCollections": [         // Populated if selectionMode='include'
    "users",
    "products"
  ],
  "selectionMode": "include",      // Mode used ('all', 'include', 'exclude')
  "excludedCollections": [],       // Populated if selectionMode='exclude'
  "timestamp": 1698480000000,      // Unix timestamp (ms) of backup creation
  "date": "2023-10-28T08:00:00.000Z", // ISO 8601 timestamp
  "archivePath": "backup_2023-10-28_stagingServer.gz" // Relative path of the archive
}
```
This metadata aids the restore process (especially for database name mapping) and documents the backup contents.

## 🛠️ Command Line Arguments

| Argument        | Description                                                    | Example                              |
| --------------- | -------------------------------------------------------------- | ------------------------------------ |
| `--mode`        | Operation mode: `backup` or `restore`                          | `--mode backup`                      |
| `--interactive` | Force interactive mode                                         | `--interactive`                      |
| `--source`      | **Backup:** Source connection name (required if no preset)     | `--source stagingServer`             |
| `--backupMode`  | **Backup:** Collection mode: `all`, `include`, `exclude`       | `--backupMode include`               |
| `--collections` | **Backup:** Comma-separated collections (for include/exclude)  | `--collections users,products`       |
| `--preset`      | **Backup:** Name of backup preset to use                       | `--preset "Core Staging Data"`       |
| `--backupFile`  | **Restore:** Path to backup file (`.gz`)                       | `--backupFile ./backups/mybackup.gz` |
| `--target`      | **Restore:** Target connection name                            | `--target localDev`                  |
| `--drop`        | **Restore:** Drop target collections before restore (optional) | `--drop`                             |
| `--configPath`  | Custom path to `config.json` file (optional)                   | `--configPath ./custom-config.json`  |

## 🏗️ Project Structure

```
mongo-collection-cherry-picker/
├── backups/                  # Default backup storage directory
├── src/
│   ├── core/
│   │   ├── backup-manager.ts   # Backup workflow logic
│   │   ├── restore-manager.ts  # Restore workflow logic
│   │   └── preset-manager.ts   # Preset management logic
│   ├── services/
│   │   ├── mongodb.service.ts  # MongoDB connection/query handling
│   │   ├── backup.service.ts   # mongodump execution logic
│   │   └── restore.service.ts  # mongorestore execution logic
│   ├── utils/
│   │   ├── formatter.ts        # Filename formatting
│   │   └── prompts.ts          # Interactive prompts logic
│   ├── types/
│   │   └── index.ts            # TypeScript type definitions
│   └── main.ts                 # Application entry point (CLI parsing)
├── config.json               # Default configuration file
├── README.md                 # This file
└── package.json
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## 📄 License

This project is licensed under the MIT License - see the `LICENSE` file for details (if one exists).
