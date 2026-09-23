"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function TrashButton({
  id,
  deleted: initialDeleted,
  title,
}: {
  id: string;
  deleted: boolean;
  title: string;
}) {
  const router = useRouter();
  const [deleted, setDeleted] = useState(initialDeleted);
  const [pending, setPending] = useState(false);

  async function onToggle() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/articles/${id}/trash`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleted: !deleted }),
      });
      if (res.ok) {
        const data = (await res.json()) as { deleted: boolean };
        setDeleted(data.deleted);
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
      aria-label={`${deleted ? "Restore" : "Trash"} ${title}`}
    >
      {deleted ? "Restore" : "Trash"}
    </button>
  );
}
