/**
 * Runs before every test file (vite.config.ts, test.setupFiles).
 *
 * Each test file stands for one tab of the app. Dexie tells other tabs about
 * every write on a BroadcastChannel it opens when it loads. Under the threads
 * pool every test file runs in one process, and Node's BroadcastChannel reaches
 * across worker threads, so one file's writes woke another file's live queries
 * on the same 'tally' database: a test that counts reads (useKeyedLiveQuery)
 * saw dozens, depending on what ran beside it. Without the channel, Dexie keeps
 * its notices inside the file, as within one tab.
 */
Object.defineProperty(globalThis, 'BroadcastChannel', { value: undefined, configurable: true, writable: true })
