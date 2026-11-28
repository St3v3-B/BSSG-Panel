"use client";
import { CircleAlert, Eye, EyeOff, Trash2, Wand2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/app/_components/ui/dialog";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { CopyPill, generatePassword, StrengthMeter } from "./primitives";

/** Wachtwoordveld met tonen/verbergen, genereren, kopiëren en sterktemeter. */
export function PasswordField({ id, value, onChange, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const all = useT();
  const t = all.mail.mailboxes;
  const [show, setShow] = useState(false);
  const tooShort = value.length > 0 && value.length < 12;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t.password}</Label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            id={id}
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus={autoFocus}
            className="pr-11 font-mono"
            aria-invalid={tooShort || undefined}
            aria-describedby={`${id}-hint`}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 md:w-9"
            aria-label={show ? t.hidePassword : t.showPassword}
            aria-pressed={show}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            onChange(generatePassword());
            setShow(true);
          }}
          data-testid="password-generate"
        >
          <Wand2 /> <span className="max-sm:sr-only">{t.generate}</span>
        </Button>
        {value && <CopyPill value={value} label={all.mail.copy} className="h-11 md:h-9 max-sm:px-3 max-sm:[&>span]:sr-only" />}
      </div>
      <p id={`${id}-hint`} className={cn("text-xs", tooShort ? "text-destructive" : "text-muted-foreground")}>
        {t.passwordTooShort}
      </p>
      <StrengthMeter password={value} />
    </div>
  );
}

/** Bevestiging waarin de gebruiker `confirmText` letterlijk moet typen. */
export function TypeToConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  actionLabel,
  pending,
  error,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: ReactNode;
  confirmText: string;
  actionLabel: string;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const match = typed.trim().toLowerCase() === confirmText.toLowerCase();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped("");
        onOpenChange(o);
      }}
    >
      <DialogContent closeLabel={t.common.close} data-testid="confirm-delete">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (match && !pending) onConfirm();
          }}
        >
          <span className="mb-3 grid size-11 place-items-center rounded-xl bg-destructive/12 text-destructive">
            <Trash2 className="size-5" />
          </span>
          <DialogTitle className="pr-8 text-lg font-semibold break-all">{title}</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">{description}</DialogDescription>
          {children}
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="confirm-type">
              {t.mail.detail.typeToConfirmPre} <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8rem] text-foreground">{confirmText}</code> {t.mail.detail.typeToConfirmPost}
            </Label>
            <Input id="confirm-type" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus className="font-mono" data-testid="confirm-input" />
          </div>
          {error != null && (
            <Alert variant="destructive" className="mt-4">
              <CircleAlert />
              <AlertDescription className="mt-0">{errorText(error)}</AlertDescription>
            </Alert>
          )}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline">{t.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={!match || pending} data-testid="confirm-go">
              {pending ? <Spinner /> : <Trash2 />} {actionLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Eenvoudige bevestiging (zonder typen). */
export function ConfirmDialog({
  open,
  onOpenChange,
  icon,
  tone = "default",
  title,
  description,
  actionLabel,
  pending,
  error,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  icon: ReactNode;
  tone?: "default" | "destructive" | "warning";
  title: string;
  description: ReactNode;
  actionLabel: string;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const tile = { default: "bg-primary/12 text-primary", destructive: "bg-destructive/12 text-destructive", warning: "bg-warning/12 text-warning" }[tone];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t.common.close}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending) onConfirm();
          }}
        >
          <span className={cn("mb-3 grid size-11 place-items-center rounded-xl [&_svg]:size-5", tile)}>{icon}</span>
          <DialogTitle className="pr-8 text-lg font-semibold">{title}</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">{description}</DialogDescription>
          {children}
          {error != null && (
            <Alert variant="destructive" className="mt-4">
              <CircleAlert />
              <AlertDescription className="mt-0">{errorText(error)}</AlertDescription>
            </Alert>
          )}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline">{t.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" variant={tone === "destructive" ? "destructive" : "default"} disabled={pending} data-testid="confirm-action">
              {pending && <Spinner />} {actionLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Formulierdialoog met titel en verzendknop. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  pending,
  error,
  disabled,
  onSubmit,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  disabled?: boolean;
  onSubmit: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t.common.close} data-testid={testId}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending && !disabled) onSubmit();
          }}
          noValidate
        >
          <DialogTitle className="pr-8 text-lg font-semibold break-all">{title}</DialogTitle>
          {description ? <DialogDescription className="mt-1 text-sm text-muted-foreground">{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
          <div className="mt-5 space-y-4">{children}</div>
          {error != null && (
            <Alert variant="destructive" className="mt-4">
              <CircleAlert />
              <AlertDescription className="mt-0">{errorText(error)}</AlertDescription>
            </Alert>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline">{t.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" disabled={pending || disabled} data-testid="form-submit">
              {pending && <Spinner />} {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
