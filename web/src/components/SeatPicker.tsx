import type { Meta } from "../api";
import { Avatar } from "./PlayerBar";
import { RiskBadge } from "./RiskBadge";

export interface SeatChoice {
  model: string;
  effort: string;
  personality: string;
}

export function SeatPicker({ meta, value, onChange, compact }: { meta: Meta; value: SeatChoice; onChange: (v: SeatChoice) => void; compact?: boolean }) {
  const model = meta.models.find((m) => m.model === value.model) ?? meta.models[0];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 8 }}>
        <label className="field">
          Model
          <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {["claudeAgent", "codex"].map((prov) => (
              <optgroup key={prov} label={prov === "codex" ? "Codex" : "Claude"}>
                {meta.models
                  .filter((m) => m.provider === prov)
                  .map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field">
          Effort
          <select value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
            {model.efforts.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        </label>
      </div>
      {compact ? (
        <label className="field">
          Personality
          <select value={value.personality} onChange={(e) => onChange({ ...value, personality: e.target.value })}>
            {meta.personalities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.emoji} {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="field">
          Personality
          <div className="persona-grid">
            {meta.personalities.map((p) => (
              <button key={p.id} className={`persona ${value.personality === p.id ? "on" : ""}`} onClick={() => onChange({ ...value, personality: p.id })} title={p.style}>
                <Avatar personality={p.id} />
                <div>
                  <b>
                    {p.name} <RiskBadge risk={p.risk} />
                  </b>
                  <span>{p.tagline}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
