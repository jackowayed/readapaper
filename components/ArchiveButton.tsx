"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ArchiveButton({
  id,
  archived: initialArchived,
  title,
}: {
  id: string;
  archived: boolean;
  title: string;
}) {
  const router = useRouter();
  const [archived, setArchived] = useState(initialArchived);
  const [pending, setPending] = useState(false);

  async function onToggle() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/articles/${id}/archive`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
      if (res.ok) {
        const data = (await res.json()) as { archived: boolean };
        setArchived(data.archived);
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={pending}
      aria-label={`${archived ? "Unarchive" : "Archive"} ${title}`}
    >
      {archived ? "Unarchive" : "Archive"}
    </button>
  );
}
