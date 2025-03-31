# MongoDB Collection Cherry Picker 🍒

A powerful CLI tool for managing MongoDB database backups with fine-grained collection selection and preset management capabilities.

## 🚀 Overview

MongoDB Collection Cherry Picker allows you to easily create and restore database backups with precise control over which collections to include or exclude. It provides both interactive and non-interactive modes, making it suitable for both manual operations and automated scripts.

## ✨ Features

- 💾 Create MongoDB database backups with collection filtering
- 🔄 Restore databases from backup archives with flexible options:
  - Optional drop of existing collections before restore
  - Precise control over restoration process
- 📋 Three selection modes: all collections, include specific collections, or exclude specific collections
- 🔌 Support for multiple database connections and profiles
- 🖥️ Interactive command-line interface with guided workflows
- 🤖 Non-interactive mode for automation and scripts
- 💾 Save commonly used backup and restore configurations as presets
- 📝 Customizable backup filename formats
- 🗜️ Automatic GZ compression of backups
- 🔒 Support for authentication and SSL

## 📥 Installation

```bash
# Install dependencies
npm install

```

## ⚙️ Configuration

Create a `config.json` file in your project root:

```json
{
  "backupDir": "backups",
  "filenameFormat": "backup_{{datetime}}_{{source}}.gz",
  "mongodumpPath": "mongodump",
  "mongorestorePath": "mongorestore",
  "connections": [
    {
      "name": "db1",
      "database": "db1",
      "host": "localhost",
      "port": 27017
    },
    {
      "name": "db2",
      "uri": "mongodb://somehost:27017/",
      "database": "db2",
    }
  ]
}
```

## 🖥️ Usage

### Interactive Mode

To start the application in interactive mode (with guided prompts):

```bash
npx mongo-cherry-picker
```

The interactive menu will guide you through:
1. Creating a backup
2. Restoring from a backup
   - Select backup file
   - Choose target database
   - Configure restore options (drop existing collections, etc.)
3. Creating backup presets
4. Managing existing presets

### Non-Interactive Mode

For scripting and automation, use command-line arguments:

```bash
# Create a full backup
npx mongo-cherry-picker --mode backup --source "db1" --backupMode all

# Restore a backup with 'drop' option enabled
npx mongo-cherry-picker --mode restore --backupFile backup_20230415_db1.gz --target "db2" --drop
```

## 📋 Working with Presets

Presets allow you to save common backup or restore configurations for quick reuse.

### Creating a Backup Preset

In interactive mode:
1. Select "Create backup preset" from the main menu
2. Enter a name for your preset
3. Select the source database
4. Choose the selection mode (all, include, or exclude)
5. If applicable, select collections to include or exclude
6. Confirm creation

Example backup preset in config.json:
```json
"backupPresets": [
  {
    "name": "Core Data Only",
    "sourceName": "Local Development",
    "description": "Backup only essential collections",
    "selectionMode": "include",
    "collections": ["users", "products", "orders"],
    "createdAt": "2023-04-15T10:30:00Z"
  },
  {
    "name": "Full Backup Without Logs",
    "sourceName": "Production Database",
    "description": "All collections except logs",
    "selectionMode": "exclude",
    "collections": ["logs", "sessions", "analytics"],
    "createdAt": "2023-04-15T11:45:00Z"
  }
]
```


## 🛠️ Command Line Arguments

| Argument        | Description                                         | Example                              |
| --------------- | --------------------------------------------------- | ------------------------------------ |
| `--mode`        | Operation mode: backup or restore                   | `--mode backup`                      |
| `--interactive` | Force interactive mode                              | `--interactive`                      |
| `--source`      | Source connection name                              | `--source "Local MongoDB"`           |
| `--backupMode`  | Collection selection mode: all, include, or exclude | `--backupMode include`               |
| `--collections` | Comma-separated list of collections                 | `--collections users,products`       |
| `--backupFile`  | Path to backup file for restore                     | `--backupFile ./backups/mybackup.gz` |
| `--target`      | Target connection name for restore                  | `--target "Test Environment"`        |
| `--drop`        | Drop existing collections before restore            | `--drop`                             |
| `--configPath`  | Custom path to config file                          | `--configPath ./custom-config.json`  |

## 🏗️ Project Structure

```
mongo-collection-cherry-picker/
├── src/
│   ├── core/
│   │   ├── mongodb-app.ts         # Main application class
│   │   ├── backup-manager.ts      # Backup operations
│   │   ├── restore-manager.ts     # Restore operations
│   │   └── preset-manager.ts      # Preset management
│   ├── services/
│   │   ├── mongodb.service.ts     # MongoDB connection handling
│   │   ├── backup.service.ts      # Backup creation logic
│   │   └── restore.service.ts     # Restore logic
│   ├── utils/
│   │   ├── index.ts               # Utility functions
│   │   └── prompts.ts            # Interactive prompts
│   ├── types/
│   │   └── index.ts               # TypeScript type definitions
│   └── index.ts                   # Entry point
├── config.json                    # Configuration file
└── package.json
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
