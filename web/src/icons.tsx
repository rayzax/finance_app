const P: Record<string, JSX.Element> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  activity: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  budgets: (<><path d="M21 12A9 9 0 1 1 12 3v9z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" /></>),
  wealth: <path d="M3 21h18M4 10h16M12 3 3 8h18zM6 10v8M10 10v8M14 10v8M18 10v8" />,
  cash: (<><path d="M3 7a2 2 0 0 1 2-2h13v4" /><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z" /><path d="M16 14h.01" /></>),
  investments: (<><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>),
  retirement: (<><path d="M12 21v-9" /><path d="M12 12C12 7 8 5 4 5c0 4 3 7 8 7z" /><path d="M12 14c0-4 3-6 8-6 0 4-3 6-8 6z" /></>),
  credit: (<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></>),
  loans: (<><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" /><path d="M6 12h.01M18 12h.01" /></>),
  other: (<><path d="M12 3 3 8l9 5 9-5z" /><path d="M3 13l9 5 9-5" /></>),
  search: (<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>),
  export: (<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" /></>),
  chevron: <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
};

export function Ico({ name, size = 18, sw = 1.7 }: { name: string; size?: number; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
      {P[name] ?? P.other}
    </svg>
  );
}

export function Ridge({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 390 260" preserveAspectRatio="xMidYMin slice" aria-hidden="true" focusable="false">
      <path d="M0 190 L60 132 L98 160 L150 96 L196 142 L238 108 L300 168 L340 128 L390 160" stroke="rgba(201,168,106,0.14)" strokeWidth="1.2" fill="none" />
      <path d="M0 214 L48 180 L110 206 L172 150 L226 190 L282 158 L338 196 L390 176" stroke="rgba(201,168,106,0.08)" strokeWidth="1" fill="none" />
    </svg>
  );
}
