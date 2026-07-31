import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsView } from "@/components/docs/DocsView";
import { getDoc, getDocSlugs } from "@/lib/docs/content";

interface DocsRouteProps {
  params: Promise<{ slug: string[] }>;
}

// The corpus is fully known at build time: prerender all of it and 404 the rest,
// so no docs route ever needs the filesystem at runtime.
export const dynamicParams = false;

export async function generateStaticParams() {
  const slugs = await getDocSlugs();
  return slugs.filter((slug) => slug.length > 0).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: DocsRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = await getDoc(slug);
  return { title: doc?.title, description: doc?.description };
}

export default async function DocsPage({ params }: DocsRouteProps) {
  const { slug } = await params;
  const doc = await getDoc(slug);
  if (!doc) notFound();
  return <DocsView doc={doc} />;
}
