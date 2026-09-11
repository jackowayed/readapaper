import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";

export const dynamic = "force-static";

export const metadata = {
  title: "Offline — Readapaper",
  description: "You're offline. Cached articles are still readable.",
};

export default function OfflinePage() {
  return (
    <>
      <SiteHeader brandLabel="← Library" />
      <main className="narrow">
        <h1>You&apos;re offline</h1>
        <p className="muted">
          The network is unreachable. Articles and pages you&apos;ve already opened are cached and
          stay readable — new saves need a connection.
        </p>
        <p>
          <Link href="/">← Back to the library</Link>
        </p>
      </main>
    </>
  );
}
