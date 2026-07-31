import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsView } from "@/components/docs/DocsView";
import { getDoc } from "@/lib/docs/content";

export async function generateMetadata(): Promise<Metadata> {
  const doc = await getDoc([]);
  return { title: doc?.title, description: doc?.description };
}

export default async function DocsIndexPage() {
  const doc = await getDoc([]);
  if (!doc) notFound();
  return <DocsView doc={doc} />;
}
