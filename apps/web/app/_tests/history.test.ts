import { describe, expect, it } from "vitest";
import { CommandHistory } from "@/app/_lib/console";

describe("CommandHistory", () => {
  it("bladert door eerdere commando's en bewaart de huidige invoer", () => {
    const h = new CommandHistory();
    h.push("list");
    h.push("say hoi");
    h.push("say hoi"); // dubbel direct na elkaar → één keer
    expect(h.all).toEqual(["list", "say hoi"]);
    expect(h.prev("half getypt")).toBe("say hoi");
    expect(h.prev("say hoi")).toBe("list");
    expect(h.prev("list")).toBe("list"); // begin bereikt
    expect(h.next()).toBe("say hoi");
    expect(h.next()).toBe("half getypt");
    expect(h.next()).toBe("half getypt");
  });

  it("houdt maximaal `max` items", () => {
    const h = new CommandHistory(["a", "b"], 3);
    h.push("c");
    h.push("d");
    expect(h.all).toEqual(["b", "c", "d"]);
  });
});
