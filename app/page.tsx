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
        {/*
          Kindle send control. The button/hint/toast are built by the inline
          script below into this EMPTY root (dangerouslySetInnerHTML): React
          never reconciles inside such a node during hydration, so the
          script's DOM updates can't race hydration (React error #418) no
          matter whether the status fetch resolves before or after hydrate.
        */}
        <div
          id="kindle-root"
          data-testid="kindle-root"
          className="kindle-row"
          dangerouslySetInnerHTML={{ __html: "" }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var root=document.getElementById("kindle-root");if(!root)return;var btn=document.createElement("button");btn.id="kindle-send";btn.setAttribute("data-testid","kindle-send");btn.type="button";btn.textContent="\\uD83D\\uDCDA Send 50 latest to Kindle";btn.disabled=true;var hint=document.createElement("span");hint.id="kindle-hint";hint.setAttribute("data-testid","kindle-status");hint.className="muted";hint.setAttribute("role","status");hint.textContent="Checking Kindle status\\u2026";var toast=document.createElement("p");toast.id="kindle-toast";toast.setAttribute("data-testid","kindle-toast");toast.className="muted";toast.setAttribute("role","status");toast.setAttribute("aria-live","polite");toast.hidden=true;root.appendChild(btn);root.appendChild(document.createTextNode(" "));root.appendChild(hint);root.appendChild(toast);function say(el,msg){el.textContent=msg;el.hidden=!msg;}fetch("/api/kindle/status").then(function(r){return r.json();}).then(function(s){var n=typeof s.activeCount==="number"?s.activeCount:0;if(s.configured&&n>0){btn.disabled=false;say(hint,"Send the "+Math.min(50,n)+" latest of "+n+" active articles.");}else if(s.configured){btn.disabled=true;say(hint,"No active articles to send yet.");}else{btn.disabled=true;say(hint,"Kindle sending needs SMTP setup \\u2014 see .env.example.");}}).catch(function(){say(hint,"Kindle status unavailable.");});btn.addEventListener("click",function(){btn.disabled=true;var label=btn.textContent;btn.textContent="Sending to Kindle\\u2026";say(toast,"");fetch("/api/kindle/send",{method:"POST"}).then(function(r){return r.json().then(function(d){return{status:r.status,body:d};});}).then(function(out){if(out.status===200&&out.body&&out.body.ok){say(toast,"Sent "+out.body.count+" articles to Kindle.");}else{var msg=(out.body&&(out.body.error||out.body.setup))||("Send failed ("+out.status+")");say(toast,String(msg));}btn.textContent=label;fetch("/api/kindle/status").then(function(r){return r.json();}).then(function(s){var n=typeof s.activeCount==="number"?s.activeCount:0;btn.disabled=!(s.configured&&n>0);}).catch(function(){});}).catch(function(){say(toast,"Kindle send failed \\u2014 try again.");btn.textContent=label;});});})();`,
          }}
        />
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
