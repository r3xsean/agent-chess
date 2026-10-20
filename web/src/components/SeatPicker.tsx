import type { Meta } from "../api";

export interface SeatChoice {
  model: string;
  effort: string;
}

export function SeatPicker({ meta, value, onChange }: { meta: Meta; value: SeatChoice; onChange: (v: SeatChoice) => void }) {
  const model = meta.models.find((m) => m.model === value.model) ?? meta.models[0];
  return (
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
  );
}
