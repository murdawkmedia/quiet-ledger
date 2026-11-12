import {CheckCircle2,Circle,TriangleAlert} from 'lucide-react';
import type {ConnectionProviderDefinition,ConnectionSummary} from '../shared/connections';
import {walletReadinessLanes,type ReadinessStepState,type WalletLaneReadiness} from '../shared/wallet-readiness';
import {Badge} from './components';

const STATE_WORDS:Record<ReadinessStepState,string>={done:'Done',todo:'To do',attention:'Needs your confirmation'};

function laneBadge(lane:WalletLaneReadiness):{label:string;tone:'neutral'|'good'|'warm'}{
  if(lane.bestStatus==='none')return {label:'Not set up',tone:'neutral'};
  if(lane.bestStatus==='unavailable')return {label:'Last check failed',tone:'warm'};
  if(lane.bestStatus==='manual')return {label:'Saved · manual confirmation',tone:'neutral'};
  if(!lane.metadataVerified)return {label:'Saved · confirmation needed',tone:'neutral'};
  return lane.unavailableCount>0?{label:'Metadata verified · mixed checks',tone:'good'}:{label:'Metadata verified',tone:'good'};
}

/**
 * Read-only overview derived from the same public connections data the page already shows.
 * It performs no network call and adds no control: saving, rechecking and disconnecting stay
 * in the existing panels, and no credential, address, seed or field value is ever displayed.
 */
export function WalletReadinessPanel({providers,connections}:{providers:ConnectionProviderDefinition[];connections:ConnectionSummary[]}){
  const lanes=walletReadinessLanes({providers,connections});
  return <section className="panel wallet-readiness-panel" aria-labelledby="wallet-readiness-title">
    <div className="panel-heading"><div><h2 id="wallet-readiness-title">Wallet readiness</h2><p>Review saved settings, connection checks and any payment-verification steps. A connection check does not prove payment; verified payments appear on your invoices and receipts.</p></div><Badge tone="ink">Read-only overview</Badge></div>
    <div className="wallet-readiness-grid">
      {lanes.map(lane=>{
        const badge=laneBadge(lane);
        return <article className="wallet-readiness-lane" key={lane.walletOptionId} aria-label={`${lane.name} readiness`}>
          <div className="wallet-readiness-lane-top"><h3>{lane.name}</h3><Badge tone={badge.tone}>{badge.label}</Badge></div>
          <ol className="wallet-readiness-steps">
            {lane.steps.map(step=><li key={step.id} className={`wallet-readiness-step wallet-readiness-${step.state}`}>
              <span className="wallet-readiness-state">{step.state==='done'?<CheckCircle2 size={13} aria-hidden="true"/>:step.state==='attention'?<TriangleAlert size={13} aria-hidden="true"/>:<Circle size={13} aria-hidden="true"/>}{STATE_WORDS[step.state]}</span>
              <span className="wallet-readiness-copy"><strong>{step.label}.</strong> {step.detail}</span>
            </li>)}
          </ol>
        </article>;
      })}
    </div>
    <p className="wallet-readiness-note">These checks cover the connections saved on this page. Use Recheck connection to update a check, and your invoices and receipts to review actual payments.</p>
  </section>;
}
