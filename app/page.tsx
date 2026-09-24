import Link from "next/link";
import SaveForm from "@/components/SaveForm";
import ArticleList from "@/components/ArticleList";
import KindleSend from "@/components/KindleSend";
import ListenQueueLink from "@/components/ListenQueueLink";
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
  searchParams?: Promise<{
    archived?: string;
    liked?: string;
    deleted?: string;
    q?: string;
    sort?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  const showTrash = params.deleted === "1";
  const showLiked = !showTrash && params.liked === "1";
  const showArchived = !showTrash && !showLiked && params.archived === "1";
  const q = (params.q ?? "").trim();
  const sort: SortKey =
    params.sort !== undefined && (SORT_KEYS as string[]).includes(params.sort)
      ? (params.sort as SortKey)
      : "newest";
  const query = q || undefined;
  const articles = showTrash
    ? (
        await listArticles({
          ...(params.archived === "1"
            ? { archived: true as const }
            : params.archived === "0"
              ? { archived: false as const }
              : {}),
          deleted: true,
          q: query,
          sort,
        })
      ).map(toSummary)
    : showLiked
      ? (
          await listArticles({
            ...(params.archived === "all"
              ? {}
              : params.archived === "1"
                ? { archived: true as const }
                : { archived: false as const }),
            liked: true,
            q: query,
            sort,
          })
        ).map(toSummary)
      : (await listArticles({ archived: showArchived, q: query, sort })).map(toSummary);
  const archivedCount = (await listArticles({ archived: true })).length;
  const activeCount = (await listArticles({ archived: false })).length;
  const likedCount = (await listArticles({ liked: true })).length;
  const trashCount = (await listArticles({ deleted: true })).length;
  const scopeCount = showTrash
    ? trashCount
    : showLiked
      ? likedCount
      : showArchived
        ? archivedCount
        : activeCount;
  const filtering = q !== "" || sort !== "newest";
  const headingCount = filtering ? articles.length : scopeCount;
  const libraryHref = (scope: "active" | "archived" | "liked" | "trash") => {
    const sp = new URLSearchParams();
    if (scope === "archived") sp.set("archived", "1");
    else if (scope === "liked") sp.set("liked", "1");
    else if (scope === "trash") sp.set("deleted", "1");
    if (q) sp.set("q", q);
    if (sort !== "newest") sp.set("sort", sort);
    const s = sp.toString();
    return s ? `/?${s}` : "/";
  };
  const scopeHref = showTrash
    ? "/?deleted=1"
    : showLiked
      ? params.archived === "all"
        ? "/?liked=1&archived=all"
        : "/?liked=1"
      : showArchived
        ? "/?archived=1"
        : "/";
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
        <h2>Library ({headingCount})</h2>
        <KindleSend />
        <ListenQueueLink />
        <nav aria-label="Library filter">
          <Link
            href={libraryHref("active")}
            aria-current={!showArchived && !showLiked && !showTrash ? "page" : undefined}
          >
            Active ({activeCount})
          </Link>{" "}
          |{" "}
          <Link href={libraryHref("archived")} aria-current={showArchived ? "page" : undefined}>
            Archived ({archivedCount})
          </Link>{" "}
          |{" "}
          <Link href={libraryHref("liked")} aria-current={showLiked ? "page" : undefined}>
            Liked ({likedCount})
          </Link>{" "}
          |{" "}
          <Link href={libraryHref("trash")} aria-current={showTrash ? "page" : undefined}>
            Trash ({trashCount})
          </Link>
        </nav>
        <form method="get" role="search" aria-label="Search and sort library">
          {showArchived && <input type="hidden" name="archived" value="1" />}
          {showLiked && <input type="hidden" name="liked" value="1" />}
          {showTrash && <input type="hidden" name="deleted" value="1" />}
          {showLiked && params.archived === "all" && (
            <input type="hidden" name="archived" value="all" />
          )}
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
          {filtering && <Link href={scopeHref}>Clear</Link>}
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
