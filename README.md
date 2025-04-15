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
  "filenameFormat": "backup_{{datetime}}_{{source}}.gz", // Format for backup filenames. Placeholders: {{date}} (DD-MM-YYYY), {{datetime}} (DD-MM-YYYY_HH-mm), {{source}}
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
        "privateKey": "~/.ssh/id_rsa", // Path to your SSH private key (~/ is expanded)
        "passphrase": "your_key_passphrase", // Optional: if your key is protected
        "password": "your_password" // Optional: if your key is protected
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
      "queryStartTime": "2023-10-27T00:00:00Z", // Optional: Example start time
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
    *   `{{date}}`: Replaced with the current date (DD-MM-YYYY).
    *   `{{datetime}}`: Replaced with the current date and time (e.g., `08-04-2025_15-30`). Recommended for preventing overwrites.
    *   `{{source}}`: Replaced with the `name` of the source connection.
*   `mongodumpPath`, `mongorestorePath`: Optional: Specify the full path to the executables if not in system PATH.
*   `connections`: Array of MongoDB connection configurations.
    *   `name`: Unique identifier.
    *   `uri`: MongoDB connection string (recommended). Takes precedence over host/port/auth fields.
    *   `database`: Target database name.
    *   `host`, `port`, `username`, `password`, `authenticationDatabase`/`authSource`: Used if `uri` is not provided.
    *   `ssh`: Optional object for connections requiring an SSH tunnel (`host`, `port`, `username`, `privateKey`, `passphrase`, `password`).
*   `backupPresets`: Optional array of predefined backup configurations.
    *   `name`: Unique identifier.
    *   `sourceName`: The `name` of the connection to use.
    *   `selectionMode`: `'include'`, `'exclude'`, or `'all'`.
    *   `collections`: Array of collection names (required if `selectionMode` is `'include'` or `'exclude'`).
    *   `queryStartTime`: Optional string. Can be used to specify a start time for the backup query (e.g., for point-in-time recovery scenarios or data filtering based on time). Format should be suitable for MongoDB's `--query` option if used.
    *   `createdAt`: Timestamp (managed by the tool).

## 🖥️ Usage

Run the tool using `ts-node` (for development) or `node` (after building).

```bash
# Using ts-node for interactive mode
npx ts-node src/apps/interactive.ts

# Using ts-node for CLI mode
npx ts-node src/apps/cli.ts [arguments]

# Using compiled code for interactive mode
node dist/apps/interactive.js

# Using compiled code for CLI mode
node dist/apps/cli.js [arguments]
```

### Interactive Mode

Start the tool in interactive mode for a guided experience:

```bash
# Using ts-node
npx ts-node src/apps/interactive.ts
# or
# Using compiled code
node dist/apps/interactive.js
```

The menu allows you to:
1.  Create a backup (selecting connection, mode, collections).
2.  Restore from a backup (selecting backup file, target connection, options like `--drop`).
3.  Create backup presets.
4.  Manage (view/delete) existing presets.

### Non-Interactive Mode

Use command-line arguments with the CLI entry point for automation. *(Note: CLI functionality is currently under development. Detailed argument documentation will be added once finalized.)*

```bash
# Example of running the CLI entry point:
node dist/apps/cli.js [arguments]
# or using ts-node:
# npx ts-node src/apps/cli.ts [arguments]
```

## 💾 Backup Metadata (`<backup_file_name>.gz.json`)

Each backup archive (e.g., `backup_2023-10-28_stagingServer.gz`) has a corresponding JSON metadata file (e.g., `backup_2023-10-28_stagingServer.gz.json`).

```json
{
  "source": "stagingServer",               // Name of the source connection
  "database": "stagingdb",                 // Name of the database backed up
  "selectionMode": "include",              // Mode used ('all', 'include', 'exclude')
  "includedCollections": [                 // Populated if selectionMode='include'
    "users",
    "products"
  ],
  // "excludedCollections": [],             // Populated if selectionMode='exclude' (absent otherwise)
  "timestamp": 1698480000000,              // Unix timestamp (ms) of backup creation
  "date": "2023-10-28T08:00:00.000Z",     // ISO 8601 timestamp
  "archivePath": "backup_2023-10-28_stagingServer.gz", // Relative path of the archive
  "presetName": "Core Staging Data",       // Optional: Name of the preset used
  "queryStartTime": "2023-10-27T00:00:00Z"  // Optional: Start time used for query
}
```
This metadata aids the restore process (especially for database name mapping) and documents the backup contents.

## 🏗️ Project Structure

```
mongo-collection-cherry-picker/
├── backups/                  # Default backup storage directory
├── src/
│   ├── apps/                 # Entry points for different application modes (CLI, Interactive)
│   ├── controllers/          # Handles user input and orchestrates actions for different modes
│   ├── modules/              # NestJS modules organizing features for different modes
│   ├── services/             # Core business logic and external interactions
│   ├── types/                # TypeScript type definitions and interfaces
│   ├── utils/                # Utility functions and helpers
│   ├── zod-schemas/          # Zod schemas for data validation
├── config.json               # Default configuration file
├── README.md                 # This file
└── package.json              # Project dependencies and scripts
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## 📄 License

This project is licensed under the MIT License - see the `LICENSE` file for details (if one exists).
