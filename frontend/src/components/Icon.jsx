const paths = {
  overview: <><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></>,
  documents: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></>,
  conversations: <><path d="M21 15a2 2 0 0 1-2 2H9l-4 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1"/><path d="M7 8h7M7 12h5M18 9h3v4h-3z"/></>,
  leads: <><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></>,
  team: <path d="M21 11.5a8.5 8.5 0 0 1-12.8 7.3L3 21l1.7-5.2A8.5 8.5 0 1 1 21 11.5z"/>,
  inbox: <><path d="M4 4h16l2 12v4H2v-4z"/><path d="M2 16h6l2 2h4l2-2h6"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 3a7 7 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 3h5l.3-3a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7 7 0 0 0 .1-1z"/></>,
  traces: <path d="M2 12h4l3-9 5 18 3-9h5"/>,
  api: <><circle cx="8" cy="15" r="5"/><path d="m12 11 8-8 2 2-2 2 1 1-3 3-1-1-3 3M8 15h.01"/></>,
  embed: <><path d="m8 6-6 6 6 6M16 6l6 6-6 6"/></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 17v4h16v-4"/></>,
  trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6M10 10v6m4-6v6"/></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  check: <path d="m4 12 5 5L20 6"/>, external: <path d="M7 17 17 7M7 7h10v10"/>, send: <><path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, 'arrow-left': <path d="m12 19-7-7 7-7M5 12h14"/>,
  alert: <><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></>, search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  logout: <><path d="M10 17v3H4V4h6v3m4 10 5-5-5-5m5 5H8"/></>, refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a7 7 0 0 1 12-2l3 5M4 12l3 5a7 7 0 0 0 12-2"/></>,
  'chevrons-up-down': <path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>, x: <path d="M5 5l14 14M19 5 5 19"/>,
};
export default function Icon({ name, size = 16, className }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
