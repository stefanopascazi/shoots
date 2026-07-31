import Image from "next/image";

export function Logo({ className = "size-7" }: { className?: string }) {
  return (
    <Image
      src="/assets/shoots.svg"
      alt=""
      width={32}
      height={32}
      className={className}
      priority
    />
  );
}
