"use client";
import { Play, RotateCw, Skull, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { PowerAction, ServerStatus } from "@panel/api";
import { Button } from "@/app/_components/ui/button";
import { Spinner } from "@/app/_components/ui/spinner";
import { useT } from "@/app/_lib/i18n";

/** Welke power-acties zinvol zijn in deze status. */
export function powerAvailability(status: ServerStatus): Record<PowerAction, boolean> {
  const busy = status === "installing" || status === "install_failed";
  const running = status === "online" || status === "starting" || status === "stopping";
  return {
    start: !busy && !running && status !== "disk_exceeded",
    restart: !busy && running && status !== "stopping",
    stop: !busy && (status === "online" || status === "starting"),
    kill: !busy && running,
  };
}

export function PowerButtons({ status, pending, onPower }: { status: ServerStatus; pending?: PowerAction; onPower: (a: PowerAction) => void }) {
  const t = useT();
  const can = powerAvailability(status);
  const [confirmKill, setConfirmKill] = useState(false);
  useEffect(() => {
    if (!confirmKill) return;
    const t = setTimeout(() => setConfirmKill(false), 4000);
    return () => clearTimeout(t);
  }, [confirmKill]);
  const icon = (a: PowerAction, I: typeof Play) => (pending === a ? <Spinner /> : <I />);
  return (
    <div className="grid w-full grid-cols-4 items-center gap-1.5 sm:flex sm:w-auto sm:flex-wrap sm:gap-2" data-testid="power-buttons">
      <Button size="sm" className="max-sm:px-1.5" onClick={() => onPower("start")} disabled={!can.start || !!pending}>
        {icon("start", Play)} {t.power.start}
      </Button>
      <Button size="sm" variant="secondary" className="max-sm:px-1.5" onClick={() => onPower("restart")} disabled={!can.restart || !!pending}>
        {icon("restart", RotateCw)} {t.power.restart}
      </Button>
      <Button size="sm" variant="secondary" className="max-sm:px-1.5" onClick={() => onPower("stop")} disabled={!can.stop || !!pending}>
        {icon("stop", Square)} {t.power.stop}
      </Button>
      <Button
        size="sm"
        className="max-sm:px-1.5"
        variant={confirmKill ? "destructive" : "outline"}
        onClick={() => {
          if (!confirmKill) return setConfirmKill(true);
          setConfirmKill(false);
          onPower("kill");
        }}
        disabled={!can.kill || !!pending}
        title={t.power.killTitle}
      >
        {icon("kill", Skull)} {confirmKill ? t.power.killConfirm : t.power.kill}
      </Button>
    </div>
  );
}
