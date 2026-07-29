require("dotenv").config();
const { verifyBackup, BackupError } = require("../lib/backup-utils");

function fileArgument(argv) {
  const index = argv.indexOf("--file");
  if (index === -1) return undefined;
  if (!argv[index + 1]) throw new BackupError("INVALID_ARGUMENT", "--file requires a backup file name.");
  return argv[index + 1];
}

let requested;
try {
  requested = fileArgument(process.argv.slice(2));
} catch (error) {
  console.error(`Backup verification failed [${error.code}]: ${error.message}`);
  process.exitCode = 1;
}

if (!process.exitCode) {
  verifyBackup(process.env, requested)
    .then((result) => {
      console.log("Backup verification passed");
      console.log(`File: ${result.backupFile}`);
      console.log(`Integrity: ${result.integrityCheck}`);
      console.log(`Foreign key violations: ${result.foreignKeyCheckCount}`);
    })
    .catch((error) => {
      const code = error instanceof BackupError ? error.code : "VERIFICATION_FAILED";
      console.error(`Backup verification failed [${code}]: ${error instanceof BackupError ? error.message : "Unexpected verification error."}`);
      process.exitCode = 1;
    });
}
