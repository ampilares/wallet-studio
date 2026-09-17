import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withFileLock } from "../utils/fileLock.js";

export class JsonStore<T> {
  private readonly filePath: string;

  constructor(filePath: string, private readonly defaultValue: T) {
    this.filePath = path.resolve(filePath);
  }

  private locked<R>(work: () => Promise<R>): Promise<R> {
    return withFileLock(`${this.filePath}.lock`, work);
  }

  private async readUnlocked(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return structuredClone(this.defaultValue);
    }
    return JSON.parse(raw) as T;
  }

  private async writeUnlocked(value: T): Promise<void> {
    const serialized = JSON.stringify(value, null, 2);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  ensure(): Promise<void> {
    return this.locked(async () => {
      await this.writeUnlocked(await this.readUnlocked());
    });
  }

  read(): Promise<T> {
    return this.locked(() => this.readUnlocked());
  }

  write(value: T): Promise<void> {
    return this.locked(async () => {
      await this.readUnlocked();
      await this.writeUnlocked(value);
    });
  }

  update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return this.locked(async () => {
      const next = await mutator(await this.readUnlocked());
      await this.writeUnlocked(next);
      return next;
    });
  }
}
