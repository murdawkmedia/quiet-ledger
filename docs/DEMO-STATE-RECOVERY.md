# Native demo identity and MLS recovery

The ledger database backup does not include Riley and Jordan's native Marmot
identities, private signing keys, MLS ratchets or native message history. Keep a
separate encrypted native-state archive with its matching ledger recovery point.
The browser's human identity and decrypted history remain in its browser profile;
this archive does not recover or transfer that browser identity.

`ops/demo-state-backup.ts` provides cold backup, verification and restore. It uses
the existing authenticated QLB/AES-256-GCM envelope with the separate context
`quiet-ledger/demo-native/v1`. A ledger archive cannot substitute for this archive.
The hosting operator holding the backup key can decrypt it. This is not
zero-knowledge storage.

## Before backup

Stop the dedicated Quiet Ledger app and both native role processes cleanly. Do
not stop unrelated Hermes profiles or sibling services. The native factory removes
its `.writer-lock` when it closes. The backup refuses any existing writer lock,
and refuses a recorded PID whose Linux process start time is still live. It never
kills a process or removes a pre-existing lock. Do not delete a lock to bypass this
check. Linux `/proc` is required for cold-process verification.

The operation briefly takes its own exclusive native writer lock. That lock
blocks a simultaneous factory restart until the encrypted archive is durable.
The source is otherwise read-only. Old `runtime-process` PID records are verified
as dead and excluded from the archive; the next runtime records fresh PIDs.

Runtime and output directories must be real, owned, mode 0700 paths outside source
and any parent private workspace. Files must be owned, mode 0600, regular, and have one link.
Symlinks, hard links, foreign ownership, foreign root entries and ownership marker
mismatches are rejected. The two native fixed account labels, `Riley - fictional
client` and `Jordan - fictional accountant`, are accepted only in the matching
role’s `accounts` directory; arbitrary spaced names remain rejected. The recognized root marker is
`quiet-ledger-demo-mdk-v1` plus a newline. Each UUID lease must have its exact
`.lease-marker` and both `client` and `accountant` directories.

Use the existing external `BACKUP_KEY_FILE` and `STORAGE_KEY_FILE`; both are
canonical base64url encodings of 32-byte keys in private mode 0600 files. The tool
checks that the keys differ. It never copies either key into the archive.

## Commands

From the source checkout, use `node --import tsx ops/demo-state-backup.ts`.
For a compiled release use `node ops/demo-state-backup.js`. Supply environment
variables privately through the existing runtime/container setup; do not put
keys in command arguments or logs.

```text
backup:
  DEMO_TEAM_STATE_DIR = the stopped, marked native runtime root
  BACKUP_DIR = an existing private output directory outside that root
  BACKUP_KEY_FILE = the existing external backup-key file
  STORAGE_KEY_FILE = the separate external storage-key file

verify:
  BACKUP_FILE = an existing encrypted native-state .qlb archive
  BACKUP_KEY_FILE and STORAGE_KEY_FILE = the same independent external files

restore:
  BACKUP_FILE, BACKUP_KEY_FILE and STORAGE_KEY_FILE = as above
  RESTORE_DEMO_DIR = a new, nonexistent destination under a real owned 0700 parent
```

The command argument is `backup` (default), `verify`, or `restore`. Success writes
one JSON metadata object. Backup includes a random archive basename, encrypted
SHA256, byte size and counts. It prints no absolute runtime path, private key,
transcript, model credential or relay capability. Failures use one generic error.

The exported TypeScript API is synchronous:

```typescript
createDemoStateBackup({runtimeRoot, outputDir, backupKeyFile, storageKeyFile});
verifyDemoStateBackup({backupPath, backupKeyFile, storageKeyFile});
restoreDemoStateBackup({backupPath, backupKeyFile, storageKeyFile, destination});
```

`createDemoStateBackup().file` is the basename inside `outputDir`.

## Restore acceptance

Verification authenticates the archive and checks the full manifest before any
restore directory is created. The manifest contains only native relative paths,
file hashes and base64 bytes. It is limited to 1000 files and 1000 directories,
16 MiB per file,48 MiB raw contents, and 64 MiB plaintext manifest plus the
32-byte envelope overhead. Paths reject traversal, duplicate entries, missing
parents, file/directory conflicts and unsupported root layout. Restore refuses
any existing destination, including an empty one, and never overwrites keys.

Restore to a separate protected path first. Compare native identity/MLS file
hashes without displaying their contents, then exercise the restored native
accounts against the matching ledger lease and the original browser identity.
Verify both agents decrypt and send without duplicate replies. Native keys alone
do not restore server lease/relay authorization or a lost browser key. Do not
start both the original and restored copies of an MLS identity at once.

After a successful recovery, keep the archive encrypted and retain an independent
private copy plus the separately protected recovery keys. Native-state backup is
cold and operator-driven; it is not added to the existing online database timer.
Natural scheduled backups, automated off-server replication and alerts are
separate operating work.

## Verification delivered with this module

Seven focused tests cover two-identity encrypted roundtrip, refusal while a writer
or recorded process is live, tampered/wrong-key/authenticated unsafe archives,
foreign/linked/exposed/reused-key input, file-size/hash bounds, no overwrite,
CLI output and the actual fixed account-directory labels. All tests use fictional
temporary state. The combined native/database backup and codec suite has 43 checks.

Actual Linux acceptance also passed with pinned wn-agent 0.14.0 and Marmot TS 0.9.0:
36 native files (about 6.94 MB raw) restored with exact hashes; the original native
home was deleted before the restored factory started. Both native public identities
and the three-member MLS roster persisted. A fresh human message produced a
new decrypted Riley reply without repeated inference or financial mutations.
That native transport/recovery test injects a typed inference fixture; actual
Hermes inference, browser and hosted acceptance remain separate evidence.

The conversational demo can hold three separate MLS rooms in the same two native
account homes. A cold archive must preserve the whole owned homes, rather than
selecting one group database. Browser room history and keys still require their
original browser storage. Direct-room and group membership must be verified
separately after recovery; a recovered group must never be relabelled as a DM.
