export function Mark({ className = "size-7" }: { className?: string }) {
  // The tool's own mark. Deliberately never rendered onto tenant output —
  // a practice's Instagram post carries the practice's brand and nothing else.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/mark.svg" alt="" className={className} />
  );
}

export function Wordmark({ className = "h-7" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/logo.svg" alt="zInstaPoster" className={className} />
  );
}
