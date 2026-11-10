import { useEffect, useRef } from "react";

/**
 * Keeps a DJ on the Live Studio page for as long as they are on air.
 *
 * The live set exists only as a WebSocket that the engine holds open while the
 * studio is mounted: navigating within the app, reloading or closing the tab
 * ends the broadcast immediately and hands the station back to automation
 * mid-show. So while `active` is true, every way off the page is cancelled and
 * the studio explains why:
 *
 *   - in-app links (the sidebar, any <a>) are intercepted in the capture phase,
 *     i.e. before React Router's own click handler can act on them;
 *   - Back/Forward is undone by a popstate listener registered at module load,
 *     before <BrowserRouter> adds its own. Listeners on the same target run in
 *     registration order, so the URL is already back on /live when the router
 *     reads it and it never unmounts the studio;
 *   - reload/close raises the browser's "leave site?" confirmation.
 */
const guard = { active: false, url: "", onAttempt: () => {} };

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (!guard.active) return;
    // Put the studio's URL back before the router's listener runs, so the
    // router sees no route change and the live page stays mounted.
    if (guard.url) history.pushState(null, "", guard.url);
    guard.onAttempt();
  });
}

/** Blocks navigation away from the current page while `active` is true. */
export function useLeaveGuard(active: boolean, onAttempt: () => void): void {
  const attempt = useRef(onAttempt);
  attempt.current = onAttempt;

  useEffect(() => {
    if (!active) return;

    guard.active = true;
    guard.url = location.href;
    guard.onAttempt = () => attempt.current();

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      // Modified clicks open a new tab/window; that leaves the broadcast running.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) return; // external links don't unmount us
      if (url.href === location.href) return;
      event.preventDefault();
      event.stopPropagation();
      attempt.current();
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers only show the prompt when returnValue is set.
      event.returnValue = "";
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      guard.active = false;
      guard.onAttempt = () => {};
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active]);
}
