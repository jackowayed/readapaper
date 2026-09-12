export type Article = {
  id: string;
  url: string;
  title: string;
  byline: string | null;
  excerpt: string | null;
  html: string;
  text: string;
  wordCount: number;
  progress: number;
  progressOffset: number;
  progressUpdatedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
};

export type ArticleSummary = Pick<
  Article,
  | "id"
  | "url"
  | "title"
  | "byline"
  | "excerpt"
  | "wordCount"
  | "progress"
  | "progressOffset"
  | "archived"
  | "archivedAt"
  | "createdAt"
>;
