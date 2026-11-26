"use client";
import Link from "next/link";
import { Button } from "@/app/_components/ui/button";
import { useT } from "@/app/_lib/i18n";

export default function NotFound() {
  const t = useT();
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="space-y-4 text-center">
        <p className="font-mono text-5xl font-semibold text-muted-foreground">404</p>
        <h1 className="text-lg font-semibold">{t.notFound.title}</h1>
        <Button asChild variant="outline">
          <Link href="/">{t.notFound.back}</Link>
        </Button>
      </div>
    </div>
  );
}
