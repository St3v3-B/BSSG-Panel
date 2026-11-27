// Eigenaar: orchestrator. Ruimere wachttijden: de machine draait vaak meerdere agents tegelijk.
import { configure } from "@testing-library/dom";

configure({ asyncUtilTimeout: 10_000 });

// jsdom kent matchMedia niet; xterm en de thema-logica roepen hem aan.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom kent ResizeObserver niet; de console-terminal (xterm fit) gebruikt hem.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
