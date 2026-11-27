import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";

class ByName extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    testTimeout: 10 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
    sequence: { concurrent: false, sequencer: ByName },
  },
});
