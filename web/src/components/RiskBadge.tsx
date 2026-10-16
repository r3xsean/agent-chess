import type { Risk } from "../../../shared/types";
import { RISK_LABEL } from "../../../shared/personalities";

export function RiskBadge({ risk }: { risk: Risk }) {
  return (
    <span className={`risk-badge risk-${risk}`} title={RISK_LABEL[risk].blurb}>
      {RISK_LABEL[risk].label}
    </span>
  );
}
