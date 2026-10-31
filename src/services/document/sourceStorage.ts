import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface DocumentSourceStorage {
  save(documentId: string, data: Uint8Array): string;
  saveFromFile(documentId: string, sourcePath: string): string;
  read(storagePath: string): Uint8Array | undefined;
  remove(storagePath: string): void;
}

export function getDocumentUploadDirectory(): string {
  return path.resolve(
    process.env.DOCUPULSE_UPLOAD_DIR || path.resolve(process.cwd(), 'data', 'uploads')
  );
}

export function getIncomingUploadDirectory(): string {
  return path.join(getDocumentUploadDirectory(), '.incoming');
}

export class FileDocumentSourceStorage implements DocumentSourceStorage {
  private readonly configuredDirectory?: string;

  constructor(directory?: string) {
    this.configuredDirectory = directory;
  }

  public save(documentId: string, data: Uint8Array): string {
    const directory = this.getDirectory();
    mkdirSync(directory, { recursive: true });
    const storagePath = path.join(directory, `${documentId}.bin`);
    const temporaryPath = `${storagePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, data, { flag: 'wx' });
      renameSync(temporaryPath, storagePath);
    } catch (error) {
      this.remove(temporaryPath);
      throw error;
    }
    return storagePath;
  }

  public saveFromFile(documentId: string, sourcePath: string): string {
    const directory = this.getDirectory();
    mkdirSync(directory, { recursive: true });
    const storagePath = path.join(directory, `${documentId}.bin`);
    try {
      renameSync(sourcePath, storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      copyFileSync(sourcePath, storagePath);
      unlinkSync(sourcePath);
    }
    return storagePath;
  }

  public read(storagePath: string): Uint8Array | undefined {
    const resolved = this.resolveStoragePath(storagePath);
    if (!existsSync(resolved)) return undefined;
    return new Uint8Array(readFileSync(resolved));
  }

  public remove(storagePath: string): void {
    try {
      rmSync(this.resolveStoragePath(storagePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private resolveStoragePath(storagePath: string): string {
    const directory = this.getDirectory();
    const resolved = path.resolve(storagePath);
    const relative = path.relative(directory, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Document storage path is outside the configured upload directory.');
    }
    return resolved;
  }

  private getDirectory(): string {
    return path.resolve(this.configuredDirectory || process.env.DOCUPULSE_UPLOAD_DIR || path.resolve(process.cwd(), 'data', 'uploads'));
  }
}

export class MemoryDocumentSourceStorage implements DocumentSourceStorage {
  private readonly files = new Map<string, Uint8Array>();

  public save(documentId: string, data: Uint8Array): string {
    const storagePath = `memory://${documentId}`;
    this.files.set(storagePath, new Uint8Array(data));
    return storagePath;
  }

  public saveFromFile(documentId: string, sourcePath: string): string {
    const data = new Uint8Array(readFileSync(sourcePath));
    rmSync(sourcePath);
    return this.save(documentId, data);
  }

  public read(storagePath: string): Uint8Array | undefined {
    const data = this.files.get(storagePath);
    return data ? new Uint8Array(data) : undefined;
  }

  public remove(storagePath: string): void {
    this.files.delete(storagePath);
  }
}

export const documentSourceStorage = new FileDocumentSourceStorage();
