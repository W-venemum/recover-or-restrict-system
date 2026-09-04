/** A simple horizontal bar used for the lightweight CSS visualisations. */
export function Bar({
  value,
  max,
  tone,
}: {
  value: number;
  max: number;
  tone: "recover" | "intervene" | "restrict" | "suspend" | "neutral";
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-track" aria-hidden>
      <div className={`bar-fill bar-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
