export function Brand() {
  return (
    <span className="brand">
      <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="13" cy="17" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <path d="M4 7.5 30 7.5" stroke="var(--primary)" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="13" cy="7.5" r="3" fill="var(--primary)" />
      </svg>
      <span className="brand-word">tangent</span>
    </span>
  );
}
