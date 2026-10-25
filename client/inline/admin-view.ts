// The first admin page's view (window.ergaView): what its scripts stop when it goes. Every admin page's scripts read
// it, the Ops page's too; admin-nav.ts makes the next page's.

export default function adminView(): void {
  window.ergaView = (() => {
    const c = new AbortController(),
      fns: (() => void)[] = [];
    return {
      signal: c.signal,
      onLeave: (fn: () => void) => {
        if (c.signal.aborted) fn();
        else fns.push(fn);
      },
      leave: () => {
        c.abort();
        for (const fn of fns.splice(0))
          try {
            fn();
          } catch (e) {
            console.error(e);
          }
      },
    };
  })();
}
