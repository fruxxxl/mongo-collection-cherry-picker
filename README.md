# MongoDB Backup Tool 🗄️

A powerful tool for automated MongoDB database backup and restoration operations.

## ✨ Features

- 💾 Create MongoDB database backups
- 🔄 Restore databases from backup files 
- 🔌 Support for multiple database connections
- 📝 Customizable backup filename format
- 🗜️ Automatic GZ compression of backups
- ⚙️ Flexible JSON configuration

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
      "name": "Local MongoDB",
      "uri": "mongodb://localhost:27017/",
      "database": "mydb",
      "host": "localhost",
      "port": 27017
    }
  ]
}
```
