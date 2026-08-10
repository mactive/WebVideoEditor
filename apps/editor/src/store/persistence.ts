import {
  deserializeProjectDocument,
  serializeProjectDocument,
  type ProjectDocument,
} from "@web-video-editor/domain";

import { projectRestored } from "./projectSlice";
import {
  persistenceFailed,
  persistenceLoading,
  persistenceSaved,
  persistenceSaving,
} from "./sessionSlice";
import type { EditorStore } from "./store";

const DATABASE_VERSION = 1;
const PROJECT_STORE = "projects";

type StoredProject = {
  id: string;
  json: string;
  savedAt: string;
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB 事务失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB 事务中止"));
  });
}

export class IndexedDbProjectRepository {
  private readonly databaseName: string;
  private readonly factory: IDBFactory;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(
    databaseName = "web-video-editor",
    factory: IDBFactory = globalThis.indexedDB,
  ) {
    if (!factory) {
      throw new Error("当前环境不支持 IndexedDB");
    }
    this.databaseName = databaseName;
    this.factory = factory;
  }

  async save(project: ProjectDocument): Promise<string> {
    const database = await this.open();
    const savedAt = new Date().toISOString();
    const transaction = database.transaction(PROJECT_STORE, "readwrite");
    transaction.objectStore(PROJECT_STORE).put({
      id: project.id,
      json: serializeProjectDocument(project),
      savedAt,
    } satisfies StoredProject);
    await transactionDone(transaction);
    return savedAt;
  }

  async load(projectId: string): Promise<ProjectDocument | null> {
    const database = await this.open();
    const transaction = database.transaction(PROJECT_STORE, "readonly");
    const record = await requestResult(
      transaction.objectStore(PROJECT_STORE).get(projectId),
    );
    await transactionDone(transaction);

    if (record === undefined) {
      return null;
    }
    const stored = record as StoredProject;
    return deserializeProjectDocument(stored.json);
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = null;
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) {
      return this.databasePromise;
    }

    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PROJECT_STORE)) {
          request.result.createObjectStore(PROJECT_STORE, {
            keyPath: "id",
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("无法打开 IndexedDB"));
      request.onblocked = () =>
        reject(new Error("IndexedDB 升级被其他页面阻塞"));
    });

    return this.databasePromise;
  }
}

export type ProjectRepository = Pick<
  IndexedDbProjectRepository,
  "load" | "save"
>;

export async function restoreProject(
  store: EditorStore,
  repository: ProjectRepository,
  projectId: string,
): Promise<ProjectDocument | null> {
  store.dispatch(persistenceLoading());
  try {
    const project = await repository.load(projectId);
    if (project) {
      store.dispatch(projectRestored(project));
    }
    store.dispatch(persistenceSaved(new Date().toISOString()));
    return project;
  } catch (error) {
    store.dispatch(persistenceFailed(errorMessage(error)));
    throw error;
  }
}

export function startProjectAutosave(
  store: EditorStore,
  repository: ProjectRepository,
  debounceMs = 250,
): () => void {
  let lastDocument = store.getState().project.document;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const unsubscribe = store.subscribe(() => {
    const document = store.getState().project.document;
    if (document === lastDocument) {
      return;
    }
    lastDocument = document;
    clearTimeout(timer);
    timer = setTimeout(() => {
      store.dispatch(persistenceSaving());
      void repository
        .save(document)
        .then((savedAt) => store.dispatch(persistenceSaved(savedAt)))
        .catch((error: unknown) =>
          store.dispatch(persistenceFailed(errorMessage(error))),
        );
    }, debounceMs);
  });

  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
