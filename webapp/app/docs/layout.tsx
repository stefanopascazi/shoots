import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { assertNavCoversContent } from "@/lib/docs/content";

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  // Fails the build when a docs page exists but is not reachable from the sidebar.
  await assertNavCoversContent();

  return (
    <div className="mx-auto flex w-full max-w-[100rem]">
      <DocsSidebar />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
