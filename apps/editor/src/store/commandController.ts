import {
  CommandBus,
  type CommandEvent,
  type CommandBusOptions,
  type ExecuteCommandOptions,
  type ProjectCommand,
  type ProjectDocument,
} from "@web-video-editor/domain";

import { projectCommitted, projectRestored } from "./projectSlice";
import type { EditorStore } from "./store";

export type ProjectCommandControllerOptions = Omit<
  CommandBusOptions,
  "onChange"
> & {
  onEvent?: (event: CommandEvent) => void;
};

export class ProjectCommandController {
  private readonly bus: CommandBus;
  private readonly store: EditorStore;
  private readonly unsubscribe: () => void;
  private observedDocument: ProjectDocument;
  private committing = false;

  constructor(
    store: EditorStore,
    options: ProjectCommandControllerOptions = {},
  ) {
    this.store = store;
    this.observedDocument = store.getState().project.document;
    const { onEvent, ...busOptions } = options;
    this.bus = new CommandBus(this.observedDocument, {
      ...busOptions,
      onChange: (project, event) => {
        this.committing = true;
        try {
          store.dispatch(projectCommitted(project));
          this.observedDocument = store.getState().project.document;
        } finally {
          this.committing = false;
        }
        onEvent?.(event);
      },
    });
    this.unsubscribe = store.subscribe(() => {
      if (!this.committing) {
        this.synchronizeFromRedux();
      }
    });
  }

  get canUndo(): boolean {
    this.synchronizeFromRedux();
    return this.bus.canUndo;
  }

  get canRedo(): boolean {
    this.synchronizeFromRedux();
    return this.bus.canRedo;
  }

  execute(
    command: ProjectCommand,
    options?: ExecuteCommandOptions,
  ): ProjectDocument {
    this.synchronizeFromRedux();
    return this.bus.execute(command, options);
  }

  undo(): ProjectDocument {
    this.synchronizeFromRedux();
    return this.bus.undo();
  }

  redo(): ProjectDocument {
    this.synchronizeFromRedux();
    return this.bus.redo();
  }

  replace(project: ProjectDocument): ProjectDocument {
    this.store.dispatch(projectRestored(project));
    return this.store.getState().project.document;
  }

  dispose(): void {
    this.unsubscribe();
  }

  private synchronizeFromRedux(): void {
    const document = this.store.getState().project.document;
    if (document === this.observedDocument) {
      return;
    }
    this.bus.replace(document);
    this.observedDocument = document;
  }
}
