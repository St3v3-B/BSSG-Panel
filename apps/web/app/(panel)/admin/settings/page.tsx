"use client";
import { PageHeader } from "@/app/_components/page-header";
import { AdminWebhookCard } from "@/app/_components/notifications/webhook-card";
import { SettingsAdmin } from "@/app/_components/admin/settings";
import { AlarmDefaultsCard } from "@/app/_components/admin/alarms";
import { TerminalSettingsCard } from "@/app/_components/admin/terminal-toggles";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function SettingsAdminPage() {
  const d = useT().admin2.settings;
  useDocumentTitle(d.docTitle);
  return (
    <>
      <PageHeader title={d.title} description={d.description} />
      <SettingsAdmin />
      <div className="mt-6 max-w-2xl space-y-6">
        <TerminalSettingsCard />
        <AdminWebhookCard />
      </div>
      <div className="mt-6 max-w-2xl">
        <AlarmDefaultsCard />
      </div>
    </>
  );
}
