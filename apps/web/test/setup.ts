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
