import {
  EXPORT_OUTPUT_DIRECTORY,
  type MediaExportResult,
} from "./export-types";

type DirectoryEntry = [
  string,
  FileSystemDirectoryHandle | FileSystemFileHandle,
];
type IterableDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<DirectoryEntry>;
};

async function exportDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("OPFS 不可用，无法创建流式导出临时文件");
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(EXPORT_OUTPUT_DIRECTORY, { create: true });
}

export async function getExportFile(
  result: Pick<MediaExportResult, "opfsPath">,
): Promise<File> {
  const directory = await exportDirectory();
  return (await directory.getFileHandle(result.opfsPath)).getFile();
}

export async function removeExportFile(path: string): Promise<void> {
  const directory = await exportDirectory();
  try {
    await directory.removeEntry(path);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) {
      throw error;
    }
  }
}

export async function listTemporaryExports(): Promise<string[]> {
  const directory = await exportDirectory();
  const paths: string[] = [];
  for await (const [name] of (directory as IterableDirectory).entries()) {
    if (name.startsWith(".tmp-")) {
      paths.push(name);
    }
  }
  return paths.sort();
}
