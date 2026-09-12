import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

function repoFile(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

function npmrcValue(key: string): string | undefined {
  for (const line of repoFile(".npmrc").split("\n")) {
    const stripped = line.split("#")[0]?.trim();
    if (!stripped) continue;
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    if (stripped.slice(0, eq).trim() === key) {
      return stripped.slice(eq + 1).trim();
    }
  }
  return undefined;
}

describe("supply-chain cooldown", () => {
  it("pins a 7-day min-release-age install gate in .npmrc", () => {
    expect(npmrcValue("min-release-age")).toBe("7");
  });

  it("holds Dependabot npm updates back 7 days", () => {
    const dependabot = repoFile(".github/dependabot.yml");
    const npmBlock =
      dependabot.split('- package-ecosystem: "npm"')[1]?.split("- package-ecosystem:")[0] ?? "";
    expect(npmBlock).toMatch(/cooldown:\s*\n\s*default-days:\s*7\b/);
  });
});
