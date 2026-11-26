// @vitest-environment jsdom
import { TRPCError } from "@trpc/server";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS } from "@panel/api/schemas";
import { FileEditor } from "@/app/_components/files/file-editor";
import { FileManager } from "@/app/_components/files/file-manager";
import { breadcrumbs, fileNameError, languageFor, normalizePath, UploadError, uploadFiles, withParam } from "@/app/_lib/files";
import { renderWithTrpc, sessionFor } from "./utils";

// Monaco laadt niet in jsdom: vervang de editor door een textarea.
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options?: { readOnly?: boolean } }) => (
    <textarea aria-label="editor" value={value} readOnly={options?.readOnly} onChange={(e) => onChange(e.target.value)} />
  ),
}));

afterEach(cleanup);

const UUID = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6";
const owner = { uuid: UUID, permissions: [...ALL_PERMISSIONS] };
const diskFull = () => {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "DISK_EXCEEDED" });
};

describe("pad-hulpjes", () => {
  it("normaliseert paden en maakt kruimels", () => {
    expect(normalizePath("plugins//a/../b/")).toBe("/plugins/b");
    expect(normalizePath("/../..")).toBe("/");
    expect(breadcrumbs("/a/b").map((c) => c.path)).toEqual(["/", "/a", "/a/b"]);
    expect(fileNameError("a/b")).toMatch(/slash/);
    expect(fileNameError("ok.txt")).toBeNull();
    expect(languageFor("server.properties")).toBe("ini");
    expect(languageFor("index.PHP")).toBe("php");
    expect(withParam("https://node1.test/x?token=t", "path", "/a b")).toBe("https://node1.test/x?token=t&path=%2Fa+b");
    expect(withParam("https://node1.test/x?token=t&path=%2Fz", "path", "/a")).toContain("path=%2Fz");
  });

  it("upload: multipart naar de daemon-URL met directory, 507 wordt UploadError", async () => {
    let sent: { method: string; url: string; body: FormData } | null = null;
    const fake = {
      status: 507,
      responseText: "disk_exceeded",
      upload: {} as { onprogress?: unknown },
      open(method: string, url: string) {
        sent = { method, url, body: new FormData() };
      },
      send(body: FormData) {
        sent!.body = body;
        (this as unknown as { onload: () => void }).onload();
      },
    };
    const p = uploadFiles("https://node1.test/api/servers/x/files/upload?token=t", "/plugins", [new File(["hi"], "a.txt")], undefined, {
      mock: false,
      xhr: () => fake as unknown as XMLHttpRequest,
    });
    await expect(p).rejects.toBeInstanceOf(UploadError);
    await expect(p).rejects.toMatchObject({ status: 507 });
    expect(sent!.method).toBe("POST");
    expect(sent!.url).toContain("directory=%2Fplugins");
    expect((sent!.body.get("files") as File).name).toBe("a.txt");
  });
});

describe("FileManager", () => {
  it("toont mappen eerst en navigeert, opent tekstbestanden in de editor", async () => {
    const onNavigate = vi.fn();
    const onEdit = vi.fn();
    renderWithTrpc(<FileManager server={owner} path="/" onNavigate={onNavigate} onEdit={onEdit} />, { session: sessionFor("admin") });
    const rows = await screen.findAllByTestId("file-row");
    expect(rows.map((r) => within(r).getAllByRole("button")[0]!.textContent)).toEqual(["plugins", "world", "server.jar", "server.properties"]);
    fireEvent.click(screen.getByRole("button", { name: "plugins" }));
    expect(onNavigate).toHaveBeenCalledWith("/plugins");
    fireEvent.click(screen.getByRole("button", { name: "server.properties" }));
    expect(onEdit).toHaveBeenCalledWith("/server.properties");
  });

  it("hernoemen, map aanmaken, inpakken en verwijderen sturen de juiste mutaties", async () => {
    const { bodies } = renderWithTrpc(<FileManager server={owner} path="/" onNavigate={() => {}} onEdit={() => {}} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");

    fireEvent.click(screen.getByRole("button", { name: "Nieuwe map" }));
    fireEvent.change(screen.getByLabelText("Naam van de nieuwe map"), { target: { value: "logs" } });
    fireEvent.click(screen.getByRole("button", { name: "Aanmaken" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "files.mkdir")?.input).toEqual({ uuid: UUID, path: "/logs" }));

    fireEvent.click(screen.getByLabelText("server.properties selecteren"));
    fireEvent.click(screen.getByLabelText("world selecteren"));
    fireEvent.click(screen.getByRole("button", { name: "Inpakken" }));
    await waitFor(() => expect(bodies.find((b) => b.path === "files.compress")?.input).toEqual({ uuid: UUID, root: "/", paths: ["/server.properties", "/world"] }));
    await screen.findByText(/Ingepakt als archive.tar.gz/);

    fireEvent.click(screen.getByLabelText("server.jar selecteren"));
    fireEvent.click(within(screen.getByTestId("selection-bar")).getByRole("button", { name: /Verwijderen/ }));
    expect(screen.getByText(/definitief verwijderen/)).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("selection-bar")).getByRole("button", { name: /^Verwijderen$/ }));
    await waitFor(() => expect(bodies.find((b) => b.path === "files.delete")?.input).toEqual({ uuid: UUID, paths: ["/server.jar"] }));
  });

  it("upload haalt eerst een upload-URL op en toont schijf vol netjes", async () => {
    const upload = vi.fn().mockRejectedValue(new UploadError("disk_exceeded", 507));
    const { bodies } = renderWithTrpc(<FileManager server={owner} path="/plugins" onNavigate={() => {}} onEdit={() => {}} upload={upload} />, {
      session: sessionFor("admin"),
    });
    await screen.findByText(/Deze map is leeg/);
    fireEvent.change(screen.getByTestId("upload-input"), { target: { files: [new File(["x"], "plugin.jar")] } });
    await screen.findByTestId("disk-exceeded");
    expect(bodies.find((b) => b.path === "files.uploadUrl")?.input).toEqual({ uuid: UUID, directory: "/plugins" });
    expect(upload).toHaveBeenCalledWith(expect.stringContaining("/files/upload"), "/plugins", expect.any(Array), expect.any(Function));
    expect(screen.getByTestId("disk-exceeded").textContent).toMatch(/schijf.*vol/i);
  });

  it("zonder files.write: geen schrijfknoppen", async () => {
    renderWithTrpc(<FileManager server={{ uuid: UUID, permissions: ["files.read"] }} path="/" onNavigate={() => {}} onEdit={() => {}} />, { session: sessionFor("admin") });
    await screen.findAllByTestId("file-row");
    expect(screen.queryByRole("button", { name: /Uploaden/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Nieuwe map/ })).toBeNull();
    expect(screen.getByText(/geen recht files.write/)).toBeTruthy();
  });

  it("ontbrekend recht van de server: FORBIDDEN wordt netjes getoond", async () => {
    renderWithTrpc(<FileManager server={owner} path="/" onNavigate={() => {}} onEdit={() => {}} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        m.files.list = () => {
          throw new TRPCError({ code: "FORBIDDEN", message: "files.read" });
        };
      },
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/geen rechten/i);
  });
});

describe("FileEditor", () => {
  it("laadt, slaat op en toont DISK_EXCEEDED", async () => {
    let fail = false;
    const { bodies } = renderWithTrpc(<FileEditor uuid={UUID} path="/server.properties" readOnly={false} onClose={() => {}} />, {
      session: sessionFor("admin"),
      patch: (m) => {
        const orig = m.files.write;
        m.files.write = (opts) => (fail ? diskFull() : orig(opts));
      },
    });
    const editor = (await screen.findByLabelText("editor")) as HTMLTextAreaElement;
    expect(editor.value).toContain("motd=Blokgenoten SMP");
    const save = screen.getByTestId("file-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(editor, { target: { value: "motd=Nieuw\n" } });
    fireEvent.click(save);
    await waitFor(() => expect(bodies.find((b) => b.path === "files.write")?.input).toEqual({ uuid: UUID, path: "/server.properties", content: "motd=Nieuw\n" }));
    await screen.findByText("opgeslagen");

    fail = true;
    fireEvent.change(editor, { target: { value: "motd=Groot\n" } });
    fireEvent.click(save);
    const alert = await screen.findByTestId("disk-exceeded");
    expect(alert.textContent).toMatch(/Schijf vol/);
    expect(screen.getByText("niet opgeslagen")).toBeTruthy();
  });

  it("alleen lezen zonder opslaan-knop", async () => {
    renderWithTrpc(<FileEditor uuid={UUID} path="/server.properties" readOnly onClose={() => {}} />, { session: sessionFor("admin") });
    await screen.findByLabelText("editor");
    expect(screen.queryByTestId("file-save")).toBeNull();
    expect(screen.getByText("alleen lezen")).toBeTruthy();
  });
});
