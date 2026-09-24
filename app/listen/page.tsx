import SiteHeader from "@/components/SiteHeader";
import ListenQueuePlayer from "@/components/ListenQueuePlayer";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Listen queue — Readapaper",
  description: "Queued articles playing one after another with synced text-to-speech.",
};

export default function ListenPage() {
  return (
    <>
      <SiteHeader brandLabel="📚 Readapaper" />
      <main className="narrow">
        <h1>▶ Listen queue</h1>
        <ListenQueuePlayer />
      </main>
    </>
  );
}
