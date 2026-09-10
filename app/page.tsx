import SaveForm from "@/components/SaveForm";
import ArticleList from "@/components/ArticleList";
import ThemeControl from "@/components/ThemeControl";
import { listArticles, toSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const articles = (await listArticles()).map(toSummary);
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/">
          📚 Readapaper
        </a>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <a className="muted" href="/bookmarklet">
            Bookmarklet
          </a>
          <ThemeControl />
        </div>
      </header>
      <main className="narrow">
        <h1>Save it. Read it. Listen in sync.</h1>
        <SaveForm />
        <p className="muted">
          Hit a paywall or bot-block?{" "}
          <a href="/bookmarklet">Get the bookmarklet</a> — it saves from the live page DOM.
        </p>
        <h2>Library ({articles.length})</h2>
        <ArticleList articles={articles} />
      </main>
    </>
  );
}
