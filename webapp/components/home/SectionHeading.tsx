interface SectionHeadingProps {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
}: SectionHeadingProps) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      {eyebrow && (
        <span className="text-[11px] font-bold uppercase tracking-widest text-accent">
          {eyebrow}
        </span>
      )}
      <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-fg sm:text-3xl">{title}</h2>
      {description && <p className="mt-3 text-sm leading-relaxed text-muted">{description}</p>}
    </div>
  );
}
