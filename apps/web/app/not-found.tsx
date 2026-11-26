import Link from "next/link";
import { Button } from "@/app/_components/ui/button";

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="space-y-4 text-center">
        <p className="font-mono text-5xl font-semibold text-muted-foreground">404</p>
        <h1 className="text-lg font-semibold">Deze pagina bestaat niet</h1>
        <Button asChild variant="outline">
          <Link href="/">Naar het overzicht</Link>
        </Button>
      </div>
    </div>
  );
}
