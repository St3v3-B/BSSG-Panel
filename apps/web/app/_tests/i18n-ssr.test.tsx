// @vitest-environment node
// Twee SSR-renders met verschillende talen die door elkaar lopen (zoals gelijktijdige requests op de server):
// hulpfuncties buiten React (getT, statusLabel, formatDate, errorText) moeten de taal van hun eigen render geven.
import { PassThrough } from "node:stream";
import { Suspense, use } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { errorText } from "@/app/_lib/errors";
import { formatDate, formatDuration, statusLabel } from "@/app/_lib/format";
import { getLocale, getT, LocaleProvider, type Locale } from "@/app/_lib/i18n";
import { en } from "@/app/_lib/i18n/en";
import { nl } from "@/app/_lib/i18n/nl";

const getTDict = (l: Locale) => (l === "nl" ? nl : en);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function Late({ wait }: { wait: Promise<void> }) {
  use(wait); // schort de render op tot de andere request zijn provider al gerenderd heeft
  return (
    <p>
      {getLocale()}|{getT().status.starting}|{statusLabel("disk_exceeded")}|{formatDuration(2 * 3600_000)}|
      {formatDate(new Date("2026-11-26T12:00:00Z"))}|{errorText({ message: "DISK_EXCEEDED", data: { code: "PRECONDITION_FAILED" } })}
    </p>
  );
}

function render(locale: Locale, wait: Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = "";
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => (html += c.toString()));
    sink.on("end", () => resolve(html.replaceAll("<!-- -->", "")));
    const s = renderToPipeableStream(
      <LocaleProvider initial={locale}>
        <Suspense fallback={<i>…</i>}>
          <Late wait={wait} />
        </Suspense>
      </LocaleProvider>,
      { onAllReady: () => s.pipe(sink), onShellError: reject, onError: reject },
    );
  });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("i18n tijdens SSR", () => {
  it("twee renders met verschillende talen door elkaar lekken niet", async () => {
    for (const [first, second] of [["nl", "en"], ["en", "nl"]] as const) {
      const a = deferred();
      const b = deferred();
      const pa = render(first, a.promise);
      await tick();
      const pb = render(second, b.promise); // tweede request rendert zijn provider terwijl de eerste nog wacht
      await tick();
      a.resolve(); // eerste request gaat verder na de provider van de tweede
      await tick();
      b.resolve();
      const [ha, hb] = await Promise.all([pa, pb]);
      for (const [html, l] of [[ha, first], [hb, second]] as const) {
        const d = getTDict(l);
        expect(html, `${l} render`).toContain(`<p>${l}|${d.status.starting}|${d.status.disk_exceeded}|2${l === "nl" ? "u" : "h"} 0m|`);
        expect(html).toContain(l === "nl" ? "nov" : "Nov");
        expect(html).toMatch(l === "nl" ? /schijf van deze server is vol/ : /disk is full/);
      }
    }
  });

  it("buiten een render: standaardtaal", () => {
    expect(getLocale()).toBe("en");
  });
});
