import Link from "next/link";
import SaveForm from "@/components/SaveForm";
import ArticleList from "@/components/ArticleList";
import OfflineCacheButton from "@/components/OfflineCacheButton";
import SiteHeader from "@/components/SiteHeader";
import { listArticles, toSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ archived?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const showArchived = params.archived === "1";
  const articles = (await listArticles({ archived: showArchived })).map(toSummary);
  const archivedCount = (await listArticles({ archived: true })).length;
  const activeCount = (await listArticles({ archived: false })).length;
  return (
    <>
      <SiteHeader brandLabel="📚 Readapaper" />
      <main className="narrow">
        <h1>Save it. Read it. Listen in sync.</h1>
        <SaveForm />
        <p className="muted">
          Hit a paywall or bot-block? <a href="/bookmarklet">Get the bookmarklet</a> — it saves from
          the live page DOM.
        </p>
        <h2>Library ({showArchived ? archivedCount : activeCount})</h2>
        <nav aria-label="Library filter">
          <Link href="/" aria-current={showArchived ? undefined : "page"}>
            Active ({activeCount})
          </Link>{" "}
          |{" "}
          <Link href="/?archived=1" aria-current={showArchived ? "page" : undefined}>
            Archived ({archivedCount})
          </Link>
        </nav>
        <OfflineCacheButton />
        <ArticleList articles={articles} />
      </main>
    </>
  );
}
