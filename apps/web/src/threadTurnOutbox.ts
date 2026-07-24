import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";

const DATABASE_NAME = "t3-thread-turn-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "turns";

export interface QueuedThreadTurn {
  readonly messageId: MessageId;
  readonly environmentId: EnvironmentId;
  readonly input: StartThreadTurnInput;
  readonly queuedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to open the turn outbox.")),
    );
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "messageId" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
  });
}

function transactionRequest<A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
): Promise<A> {
  return openDatabase().then(
    (database) =>
      new Promise<A>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = run(transaction.objectStore(STORE_NAME));
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("Turn outbox operation failed.")),
        );
        transaction.addEventListener("complete", () => database.close());
        transaction.addEventListener("abort", () => {
          database.close();
          reject(transaction.error ?? new Error("Turn outbox transaction was aborted."));
        });
      }),
  );
}

export function enqueueThreadTurn(turn: QueuedThreadTurn): Promise<void> {
  return transactionRequest("readwrite", (store) => store.put(turn)).then(() => undefined);
}

export function removeQueuedThreadTurn(messageId: MessageId): Promise<void> {
  return transactionRequest("readwrite", (store) => store.delete(messageId)).then(() => undefined);
}

export function listQueuedThreadTurns(): Promise<ReadonlyArray<QueuedThreadTurn>> {
  return transactionRequest("readonly", (store) => store.getAll()).then((turns) =>
    turns.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt)),
  );
}
