import Link from "next/link";

export function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
export const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "—";
export const fmtDay = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" }) : "—";

export function Flash({ e, ok }: { e?: string; ok?: string }) {
  if (!e && !ok) return null;
  return (
    <div role="status" className={`mb-4 rounded-lg border px-4 py-2 text-sm ${e ? "border-red-700 bg-red-950/50 text-red-200" : "border-emerald-700 bg-emerald-950/40 text-emerald-200"}`}>
      {e ?? ok}
    </div>
  );
}

export function Field({ label, name, type = "text", required, defaultValue, placeholder, hint, ...rest }:
  { label: string; name: string; type?: string; required?: boolean; defaultValue?: string | number; placeholder?: string; hint?: string } & Record<string, any>) {
  return (
    <div>
      <label className="label" htmlFor={name}>{label}</label>
      <input id={name} className="input" name={name} type={type} required={required} defaultValue={defaultValue} placeholder={placeholder} {...rest} />
      {hint && <p className="mt-1 text-xs text-mute">{hint}</p>}
    </div>
  );
}

export function TextArea({ label, name, defaultValue, rows = 4, required }: { label: string; name: string; defaultValue?: string; rows?: number; required?: boolean }) {
  return (
    <div>
      <label className="label" htmlFor={name}>{label}</label>
      <textarea id={name} className="input" name={name} rows={rows} defaultValue={defaultValue} required={required} />
    </div>
  );
}

export function Select({ label, name, options, defaultValue }: { label: string; name: string; options: { value: string; label: string }[]; defaultValue?: string }) {
  return (
    <div>
      <label className="label" htmlFor={name}>{label}</label>
      <select id={name} className="input" name={name} defaultValue={defaultValue}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function DevBanner({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 rounded-lg border border-amber-600 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">{children}</div>;
}

export function PageTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-3xl">{children}</h1>
      {sub && <p className="mt-1 text-sm text-mute">{sub}</p>}
    </div>
  );
}

export const BackLink = ({ href, children }: { href: string; children: React.ReactNode }) =>
  <Link href={href} className="mb-4 inline-block text-sm text-mute hover:text-rose">← {children}</Link>;
