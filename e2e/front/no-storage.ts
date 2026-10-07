// Node has a localStorage that warns when it's read without --localstorage-file; the room client's libraries (lib0)
// look for one as they load. Imported before them, this takes it away (lib0 keeps its state in memory then).
Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
