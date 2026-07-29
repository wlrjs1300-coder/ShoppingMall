require("dotenv").config();
const { createBackup, BackupError } = require("../lib/backup-utils");

createBackup()
  .then((result) => {
    console.log("Backup created");
    console.log(`File: ${result.backupFile}`);
    console.log(`Size: ${result.sizeBytes}`);
    console.log(`SHA-256: ${result.sha256}`);
    console.log(`Integrity: ${result.integrityCheck}`);
    console.log(`Foreign key violations: ${result.foreignKeyCheckCount}`);
  })
  .catch((error) => {
    const code = error instanceof BackupError ? error.code : "BACKUP_FAILED";
    console.error(`Backup failed [${code}]: ${error instanceof BackupError ? error.message : "Unexpected backup error."}`);
    process.exitCode = 1;
  });
