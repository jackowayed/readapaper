import { notFound } from "next/navigation";
import { getArticle } from "@/lib/store";
import { readingMinutes } from "@/lib/text";
import ThemeControl from "@/components/ThemeControl";
import ReaderClient from "@/components/ReaderClient";

export const dynamic = "force-dynamic";

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const article = await getArticle(id);
  if (!article) notFound();

  return (
    <>
      <header className="topbar">
        <a className="brand" href="/">
          ← Library
        </a>
        <ThemeControl />
      </header>
      <main className="narrow">
        <h1>{article.title}</h1>
        <p className="muted">
          {article.byline ? `${article.byline} · ` : ""}
          {article.wordCount.toLocaleString()} words · {readingMinutes(article.wordCount)} min ·{" "}
          <a href={article.url} target="_blank" rel="noopener noreferrer">
            Original
          </a>
        </p>
        {article.excerpt && <p><em>{article.excerpt}</em></p>}
        <ReaderClient article={article} />
      </main>
    </>
  );
}
