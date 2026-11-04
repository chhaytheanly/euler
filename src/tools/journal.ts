import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getConfigDir } from "../configs/config";

interface JournalEntry {
  id: string;
  displayPath: string;
  absolutePath: string;
  backupPath?: string;
  mode?: number;
  existed: boolean;
  createdAt: number;
}

const entries: JournalEntry[] = [];
const session = `${Date.now()}-${process.pid}`;
let backupDirectory: Promise<string> | null = null;

function backupDir(): Promise<string> {
  backupDirectory ??= (async () => {
    const directory = join(getConfigDir(), "backups", session);

    await mkdir(directory, {
      recursive: true,
      mode: 0o700
    });

    return directory;
  })();

  return backupDirectory;
}

/**
 * Record the state of a file before a destructive tool writes to it. The
 * previous contents are copied under the config directory so undo still works
 * after a large file scrolls out of model context.
 */
export async function recordBackup(
  absolutePath: string,
  displayPath: string
): Promise<void> {
  let info = null;

  try {
    info = await stat(absolutePath);
  } catch {
    info = null;
  }

  if (info?.isDirectory()) {
    throw new Error(`"${displayPath}" is a directory.`);
  }

  const entry: JournalEntry = {
    id: randomUUID(),
    displayPath,
    absolutePath,
    existed: Boolean(info),
    createdAt: Date.now()
  };

  if (info) {
    const directory = await backupDir();
    const target = join(
      directory,
      `${Date.now()}-${entry.id}-${basename(absolutePath)}`
    );

    await copyFile(absolutePath, target);

    entry.backupPath = target;
    entry.mode = info.mode & 0o777;
  }

  entries.push(entry);

  // Keep memory bounded while leaving a few useful steps for the user.
  while (entries.length > 50) {
    const removed = entries.shift();

    if (removed?.backupPath) {
      void rm(removed.backupPath, { force: true }).catch(() => {
        // The backup directory may already be gone.
      });
    }
  }
}

export async function undoLastBackup(): Promise<string | null> {
  const entry = entries.pop();

  if (!entry) {
    return null;
  }

  try {
    if (entry.existed && entry.backupPath) {
      const contents = await readFile(entry.backupPath);

      await mkdir(dirname(entry.absolutePath), {
        recursive: true
      });
      await writeFile(entry.absolutePath, contents, {
        mode: entry.mode ?? 0o644
      });
      await rm(entry.backupPath, { force: true });

      return `Undid the last change: restored ${entry.displayPath}.`;
    }

    await rm(entry.absolutePath, { force: true });

    return `Undid the last change: removed ${entry.displayPath}, which did not exist before.`;
  } catch (error) {
    // Keep the entry available so the user can retry the undo.
    entries.push(entry);
    throw error;
  }
}

export function backupCount(): number {
  return entries.length;
}
