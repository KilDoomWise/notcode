/**
 * FIFO-мьютексы поверх цепочки промисов.
 *
 * JS однопоточен, но любой `await` — точка переключения: два конкурентных вызова
 * тула спокойно делают read-modify-write одного файла и затирают друг друга.
 * Всё, что читает-меняет-пишет общее состояние (конфиг, индекс снапшотов,
 * журнал аудита, один и тот же файл на диске), обязано проходить через мьютекс.
 */

export class Mutex {
    private tail: Promise<unknown> = Promise.resolve();
    private queued = 0;

    /** Сколько задач сейчас в очереди (включая выполняющуюся). */
    get pending(): number {
        return this.queued;
    }

    get locked(): boolean {
        return this.queued > 0;
    }

    run<T>(task: () => Promise<T> | T): Promise<T> {
        this.queued++;

        // .then(task, task) — задача стартует и после успеха, и после ошибки предыдущей.
        const result = this.tail.then(task, task);

        this.tail = result.then(
            () => undefined,
            () => undefined
        );

        void this.tail.then(() => {
            this.queued--;
        });

        return result;
    }
}

/** Набор независимых мьютексов по ключу (например, по абсолютному пути файла). */
export class KeyedMutex {
    private readonly locks = new Map<string, Mutex>();

    get size(): number {
        return this.locks.size;
    }

    run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
        let lock = this.locks.get(key);
        if (!lock) {
            lock = new Mutex();
            this.locks.set(key, lock);
        }

        const current = lock;
        const result = current.run(task);

        // Чистим карту, когда очередь по ключу опустела, иначе она растёт бесконечно.
        void result
            .then(
                () => undefined,
                () => undefined
            )
            .then(() => {
                if (current.pending === 0 && this.locks.get(key) === current) {
                    this.locks.delete(key);
                }
            });

        return result;
    }
}
