import SaveForm from "@/components/SaveForm";
import ArticleList from "@/components/ArticleList";
import SiteHeader from "@/components/SiteHeader";
import { listArticles, toSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const articles = (await listArticles()).map(toSummary);
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
        <ArticleList articles={articles} />
      </main>
    </>
  );
}
