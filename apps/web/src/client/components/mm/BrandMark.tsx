/** MongoMation mark: an "M" drawn as a ladder rung over the Atlas leaf dot. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="12" fill="var(--color-plant-850)" />
      <rect x="1" y="1" width="62" height="62" rx="11" fill="none" stroke="var(--color-plant-600)" strokeWidth="2" />
      <path
        d="M14 46V18l18 16 18-16v28"
        fill="none"
        stroke="var(--color-plant-100)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="48" r="5" fill="var(--color-leaf-400)" />
    </svg>
  );
}
