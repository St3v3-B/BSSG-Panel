// Eigenaar: orchestrator. Ruimere wachttijden: de machine draait vaak meerdere agents tegelijk.
import { configure } from "@testing-library/dom";

configure({ asyncUtilTimeout: 10_000 });
