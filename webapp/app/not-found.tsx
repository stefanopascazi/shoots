import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-4 px-6 py-28">
      <span className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
        404
      </span>
      <h1 className="text-3xl font-extrabold tracking-tight text-fg">Page not found</h1>
      <p className="text-sm leading-relaxed text-muted">
        That page does not exist. The documentation index lists everything that does.
      </p>
      <Link
        href="/docs"
        className="rounded-full bg-fg px-5 py-2.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90"
      >
        Browse the documentation
      </Link>
    </div>
  );
}
