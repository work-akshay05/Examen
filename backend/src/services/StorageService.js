import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const extensions = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

export class LocalStorageService {
  constructor(rootDirectory) {
    this.rootDirectory = path.resolve(rootDirectory);
  }

  async save(file) {
    await mkdir(this.rootDirectory, { recursive: true });
    const storedName = `${randomUUID()}${extensions[file.mimetype]}`;
    const absolutePath = path.join(this.rootDirectory, storedName);
    await writeFile(absolutePath, file.buffer, { flag: 'wx', mode: 0o600 });
    const cleanedName = path.basename(file.originalname.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'invoice';
    return {
      metadata: {
        originalName: cleanedName, storedName, mimeType: file.mimetype, size: file.size,
        storageProvider: 'local', storagePath: storedName
      },
      content: file.buffer
    };
  }

  async remove(metadata) {
    if (!metadata?.storedName || path.basename(metadata.storedName) !== metadata.storedName) return;
    await unlink(path.join(this.rootDirectory, metadata.storedName)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async read(metadata) {
    if (!metadata?.storedName || path.basename(metadata.storedName) !== metadata.storedName) throw new Error('Invalid storage reference');
    return readFile(path.join(this.rootDirectory, metadata.storedName));
  }
}
