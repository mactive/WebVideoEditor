import { applyProjectCommand, type ProjectCommand } from "./commands";
import type { ProjectDocument } from "./schema";
import { cloneProjectDocument } from "./serialization";
import { assertValidProjectDocument } from "./validation";

export type CommandHistoryEntry = {
  transactionId: string;
  commandTypes: ProjectCommand["type"][];
  before: ProjectDocument;
  after: ProjectDocument;
};

export type CommandEvent = {
  action: "execute" | "redo" | "undo";
  transactionId: string;
  commandTypes: ProjectCommand["type"][];
  beforeRevision: number;
  afterRevision: number;
};

export type ExecuteCommandOptions = {
  transactionId?: string;
};

export type CommandBusOptions = {
  createTransactionId?: () => string;
  now?: () => string;
  onChange?: (project: ProjectDocument, event: CommandEvent) => void;
};

export class CommandBus {
  private current: ProjectDocument;
  private readonly past: CommandHistoryEntry[] = [];
  private readonly future: CommandHistoryEntry[] = [];
  private readonly createTransactionId: () => string;
  private readonly now: () => string;
  private readonly onChange?: CommandBusOptions["onChange"];

  constructor(initial: ProjectDocument, options: CommandBusOptions = {}) {
    assertValidProjectDocument(initial);
    this.current = cloneProjectDocument(initial);
    this.createTransactionId =
      options.createTransactionId ?? (() => globalThis.crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.onChange = options.onChange;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get document(): ProjectDocument {
    return cloneProjectDocument(this.current);
  }

  execute(
    command: ProjectCommand,
    options: ExecuteCommandOptions = {},
  ): ProjectDocument {
    const transactionId = options.transactionId ?? this.createTransactionId();
    const before = this.current;
    const after = applyProjectCommand(before, command, this.now());
    const previous = this.past.at(-1);

    if (previous?.transactionId === transactionId) {
      previous.after = cloneProjectDocument(after);
      previous.commandTypes.push(command.type);
    } else {
      this.past.push({
        transactionId,
        commandTypes: [command.type],
        before: cloneProjectDocument(before),
        after: cloneProjectDocument(after),
      });
    }

    this.future.length = 0;
    this.current = after;
    this.emit("execute", transactionId, [command.type], before, after);
    return this.document;
  }

  undo(): ProjectDocument {
    const entry = this.past.pop();
    if (!entry) {
      return this.document;
    }
    const before = this.current;
    this.future.push(entry);
    this.current = cloneProjectDocument(entry.before);
    this.emit(
      "undo",
      entry.transactionId,
      entry.commandTypes,
      before,
      this.current,
    );
    return this.document;
  }

  redo(): ProjectDocument {
    const entry = this.future.pop();
    if (!entry) {
      return this.document;
    }
    const before = this.current;
    this.past.push(entry);
    this.current = cloneProjectDocument(entry.after);
    this.emit(
      "redo",
      entry.transactionId,
      entry.commandTypes,
      before,
      this.current,
    );
    return this.document;
  }

  replace(project: ProjectDocument): ProjectDocument {
    assertValidProjectDocument(project);
    this.current = cloneProjectDocument(project);
    this.past.length = 0;
    this.future.length = 0;
    return this.document;
  }

  history(): readonly CommandHistoryEntry[] {
    return this.past.map((entry) => ({
      ...entry,
      commandTypes: [...entry.commandTypes],
      before: cloneProjectDocument(entry.before),
      after: cloneProjectDocument(entry.after),
    }));
  }

  private emit(
    action: CommandEvent["action"],
    transactionId: string,
    commandTypes: ProjectCommand["type"][],
    before: ProjectDocument,
    after: ProjectDocument,
  ): void {
    this.onChange?.(this.document, {
      action,
      transactionId,
      commandTypes: [...commandTypes],
      beforeRevision: before.revision,
      afterRevision: after.revision,
    });
  }
}
