import Link from "next/link";
import SaveForm from "@/components/SaveForm";
import ArticleList from "@/components/ArticleList";
import KindleSend from "@/components/KindleSend";
import OfflineCacheButton from "@/components/OfflineCacheButton";
import SiteHeader from "@/components/SiteHeader";
import { listArticles, toSummary } from "@/lib/store";
import type { SortKey } from "@/lib/store";

export const dynamic = "force-dynamic";

const SORT_KEYS: SortKey[] = ["newest", "oldest", "longest", "shortest", "progress"];

const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  longest: "Longest first",
  shortest: "Shortest first",
  progress: "Most progress",
};

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ archived?: string; q?: string; sort?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const showArchived = params.archived === "1";
  const q = (params.q ?? "").trim();
  const sort: SortKey =
    params.sort !== undefined && (SORT_KEYS as string[]).includes(params.sort)
      ? (params.sort as SortKey)
      : "newest";
  const articles = (await listArticles({ archived: showArchived, q: q || undefined, sort })).map(
    toSummary
  );
  const archivedCount = (await listArticles({ archived: true })).length;
  const activeCount = (await listArticles({ archived: false })).length;
  const libraryHref = (archived: boolean) => {
    const sp = new URLSearchParams();
    if (archived) sp.set("archived", "1");
    if (q) sp.set("q", q);
    if (sort !== "newest") sp.set("sort", sort);
    const s = sp.toString();
    return s ? `/?${s}` : "/";
  };
  const filtering = q !== "" || sort !== "newest";
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
        <h2>Library ({articles.length})</h2>
        <KindleSend />
        <nav aria-label="Library filter">
          <Link href={libraryHref(false)} aria-current={showArchived ? undefined : "page"}>
            Active ({activeCount})
          </Link>{" "}
          |{" "}
          <Link href={libraryHref(true)} aria-current={showArchived ? "page" : undefined}>
            Archived ({archivedCount})
          </Link>
        </nav>
        <form method="get" role="search" aria-label="Search and sort library">
          {showArchived && <input type="hidden" name="archived" value="1" />}
          <input
            type="search"
            name="q"
            placeholder="Search title, author, text, or URL…"
            defaultValue={q}
            maxLength={200}
            aria-label="Search library"
          />
          <select name="sort" defaultValue={sort} aria-label="Sort library">
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
          <button type="submit">Search</button>
          {filtering && <Link href={showArchived ? "/?archived=1" : "/"}>Clear</Link>}
        </form>
        <OfflineCacheButton />
        <ArticleList
          articles={articles}
          emptyLabel={
            q ? "No matches. Try a different search." : "Nothing saved yet. Paste a URL above."
          }
        />
      </main>
    </>
  );
}
