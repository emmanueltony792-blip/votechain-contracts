// Copyright 2024 VoteChain Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TransactionToast } from "../components/TransactionToast";
import { VoteConfirmationDialog, VoteChoice } from "../components/VoteConfirmationDialog";
import { useTransactionStatus } from "../hooks/useTransactionStatus";
import { useWallet } from "../context/WalletContext";
import { sanitizeText } from "../utils/sanitize";
import type { RawProposal } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VotedSet {
  [proposalId: number]: VoteChoice;
}

// ---------------------------------------------------------------------------
// Freighter signing helper
// ---------------------------------------------------------------------------

type FreighterApi = {
  isConnected: () => Promise<boolean>;
  getPublicKey: () => Promise<string>;
  getNetwork: () => Promise<string>;
  requestAccess: () => Promise<void>;
  signTransaction: (xdr: string, opts?: { network?: string }) => Promise<string>;
};

function getFreighter(): FreighterApi | undefined {
  return (window as unknown as Record<string, unknown>).freighter as
    | FreighterApi
    | undefined;
}

/**
 * Build a minimal cast_vote XDR and sign it with Freighter.
 * In a production app this would call the Stellar SDK to build a real
 * contract invocation XDR. Here we produce a deterministic placeholder
 * that encodes the vote intent so the rest of the UI flow works end-to-end.
 *
 * Returns the signed XDR hash (transaction hash after submission).
 */
async function castVoteViaFreighter(
  proposalId: number,
  choice: VoteChoice,
  network: string
): Promise<string> {
  const freighter = getFreighter();
  if (!freighter) throw new Error("Freighter extension not found.");

  // Encode a placeholder XDR representing the cast_vote call.
  // Replace this with real Stellar SDK XDR construction before mainnet.
  const payload = btoa(
    JSON.stringify({ fn: "cast_vote", proposal_id: proposalId, vote: choice })
  );

  const signedXdr = await freighter.signTransaction(payload, { network });

  // After signing, submit to Stellar RPC and return the transaction hash.
  // In production: submit signedXdr via Horizon/Soroban RPC and return the real hash.
  // For now we derive a deterministic mock hash from the signed XDR.
  const encoder = new TextEncoder();
  const data = encoder.encode(signedXdr);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function secondsUntil(endTime: number): number {
  return Math.max(0, endTime - Math.floor(Date.now() / 1000));
}

function formatDuration(secs: number): string {
  if (secs <= 0) return "Ended";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h remaining`;
  if (h > 0) return `${h}h ${m}m remaining`;
  if (m > 0) return `${m}m ${s}s remaining`;
  return `${s}s remaining`;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function QuorumBar({ total, quorum }: { total: number; quorum: number }) {
  const pct = quorum > 0 ? Math.min(100, (total / quorum) * 100) : 0;
  const met = total >= quorum;
  return (
    <div className="quorum-wrap" aria-label={`Quorum ${pct.toFixed(0)}% of ${fmt(quorum)} required${met ? ", met" : ", not yet met"}`}>
      <div
        className="quorum-bar-track"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`quorum-bar-fill${met ? " quorum-bar-fill--met" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="quorum-label">
        Quorum {pct.toFixed(0)}%{met ? " ✓" : ""}
      </span>
    </div>
  );
}

interface VoteTalliesProps {
  yes: number;
  no: number;
  abstain: number;
}

function VoteTallies({ yes, no, abstain }: VoteTalliesProps) {
  const total = yes + no + abstain;
  const yesP = total > 0 ? ((yes / total) * 100).toFixed(1) : "0.0";
  const noP = total > 0 ? ((no / total) * 100).toFixed(1) : "0.0";
  const absP = total > 0 ? ((abstain / total) * 100).toFixed(1) : "0.0";

  return (
    <div className="vote-summary" aria-label="Vote summary">
      <div
        className="vote-bar-wrap"
        role="img"
        aria-label={`Yes ${yesP}%, No ${noP}%, Abstain ${absP}%`}
      >
        <div className="vote-bar-yes" style={{ width: `${yesP}%` }} />
        <div className="vote-bar-no" style={{ width: `${noP}%` }} />
        <div className="vote-bar-abstain" style={{ width: `${absP}%` }} />
      </div>
      <div className="vote-counts">
        <span className="vote-count-item">
          <span className="vote-dot dot-yes" aria-hidden="true" />
          Yes <strong>{fmt(yes)}</strong>
        </span>
        <span className="vote-count-item">
          <span className="vote-dot dot-no" aria-hidden="true" />
          No <strong>{fmt(no)}</strong>
        </span>
        <span className="vote-count-item">
          <span className="vote-dot dot-abstain" aria-hidden="true" />
          Abstain <strong>{fmt(abstain)}</strong>
        </span>
      </div>
    </div>
  );
}

interface ProposalCardProps {
  proposal: RawProposal;
  voted: VoteChoice | undefined;
  onVote: (choice: VoteChoice) => void;
  submitting: boolean;
}

function ProposalCard({ proposal, voted, onVote, submitting }: ProposalCardProps) {
  const secs = secondsUntil(proposal.end_time);
  const endingSoon = secs > 0 && secs < 3600;

  return (
    <article
      className="proposal-card"
      aria-label={`Proposal ${proposal.id}: ${sanitizeText(proposal.title)}`}
    >
      <header className="card-header">
        <div className="card-title-row">
          <span className="proposal-id" aria-label="Proposal ID">
            #{proposal.id}
          </span>
          <h3 className="proposal-title">{sanitizeText(proposal.title)}</h3>
        </div>
        <span
          className="state-badge badge-active"
          role="status"
          aria-label="Status: Active"
        >
          Active
        </span>
      </header>

      <VoteTallies
        yes={proposal.votes_yes}
        no={proposal.votes_no}
        abstain={proposal.votes_abstain}
      />

      <QuorumBar
        total={proposal.votes_yes + proposal.votes_no + proposal.votes_abstain}
        quorum={proposal.quorum}
      />

      <div className="card-footer">
        <span
          className={`countdown${endingSoon ? " ending-soon" : ""}`}
          aria-label={`Time remaining: ${formatDuration(secs)}`}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
          >
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M7 4v3l2 1.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          {formatDuration(secs)}
        </span>
      </div>

      {voted ? (
        <p className="already-voted" aria-live="polite">
          You voted <strong>{voted}</strong> on this proposal.
        </p>
      ) : (
        <div
          className="vote-actions"
          role="group"
          aria-label={`Vote on proposal ${proposal.id}`}
        >
          {(["Yes", "No", "Abstain"] as VoteChoice[]).map((choice) => (
            <button
              key={choice}
              type="button"
              className={`vote-btn vote-btn--${choice.toLowerCase()}`}
              onClick={() => onVote(choice)}
              disabled={submitting}
              aria-label={`Vote ${choice} on proposal ${proposal.id}: ${sanitizeText(proposal.title)}`}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function VotingPanel() {
  const { t } = useTranslation();
  const { connected, connecting, connect, address, network } = useWallet();
  const { tx, submit, retry, reset } = useTransactionStatus();

  const [proposals, setProposals] = useState<RawProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Track which proposals the user has already voted on this session.
  const [voted, setVoted] = useState<VotedSet>({});

  // Confirmation dialog state
  const [pendingProposal, setPendingProposal] = useState<RawProposal | null>(null);
  const [pendingChoice, setPendingChoice] = useState<VoteChoice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Countdown tick ref
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, forceUpdate] = useState(0);

  // ── Fetch active proposals ────────────────────────────────────────────────

  const fetchProposals = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/proposals", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      const all: RawProposal[] = Array.isArray(data)
        ? data
        : (data.proposals ?? []);
      setProposals(all.filter((p) => p.state === "Active"));
    } catch (err: unknown) {
      setFetchError(
        (err as { message?: string })?.message ?? "Failed to load proposals."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) fetchProposals();
  }, [connected, fetchProposals]);

  // ── Countdown ticks ───────────────────────────────────────────────────────

  useEffect(() => {
    if (proposals.length === 0) return;
    tickRef.current = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [proposals]);

  // ── Vote flow ─────────────────────────────────────────────────────────────

  function openConfirmation(proposal: RawProposal, choice: VoteChoice) {
    setPendingProposal(proposal);
    setPendingChoice(choice);
  }

  async function confirmVote() {
    if (!pendingProposal || !pendingChoice || !network) return;
    setSubmitting(true);
    setPendingProposal(null);
    setPendingChoice(null);
    try {
      const hash = await castVoteViaFreighter(
        pendingProposal.id,
        pendingChoice,
        network
      );
      setVoted((prev) => ({ ...prev, [pendingProposal.id]: pendingChoice }));
      submit(hash);
    } catch (err: unknown) {
      // Surface signing errors through the transaction toast
      submit("error");
      console.error("[VotingPanel] castVote error:", err);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <section aria-labelledby="voting-panel-title">
      <h2 id="voting-panel-title">Voting Panel</h2>

      <TransactionToast
        tx={tx}
        onRetry={tx.hash ? () => retry(tx.hash!) : undefined}
        onDismiss={reset}
      />

      {/* Wallet not connected */}
      {!connected && (
        <div className="wallet-prompt" role="status">
          <p>Connect your Freighter wallet to browse and vote on active proposals.</p>
          <button
            type="button"
            onClick={connect}
            disabled={connecting}
            aria-label="Connect Freighter wallet"
            className="btn-primary"
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        </div>
      )}

      {/* Loading */}
      {connected && loading && (
        <p aria-busy="true" aria-live="polite">
          {t("app.loading")}
        </p>
      )}

      {/* Fetch error */}
      {connected && !loading && fetchError && (
        <div role="alert" className="error-state">
          <p>{fetchError}</p>
          <button type="button" onClick={fetchProposals} className="filter-btn">
            Retry
          </button>
        </div>
      )}

      {/* No active proposals */}
      {connected && !loading && !fetchError && proposals.length === 0 && (
        <p role="status">No active proposals found.</p>
      )}

      {/* Proposal list */}
      {connected && !loading && proposals.length > 0 && (
        <ul className="proposal-list" role="list" aria-label="Active proposals">
          {proposals.map((p) => (
            <li key={p.id}>
              <ProposalCard
                proposal={p}
                voted={voted[p.id]}
                onVote={(choice) => openConfirmation(p, choice)}
                submitting={submitting}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Vote confirmation dialog */}
      {pendingProposal && pendingChoice && (
        <VoteConfirmationDialog
          proposalTitle={sanitizeText(pendingProposal.title)}
          choice={pendingChoice}
          estimatedFee="0.00001 XLM"
          onConfirm={confirmVote}
          onCancel={() => {
            setPendingProposal(null);
            setPendingChoice(null);
          }}
        />
      )}

      {/* Connected wallet info */}
      {connected && address && (
        <p className="wallet-info" aria-label="Connected wallet address">
          Connected: {address.slice(0, 6)}…{address.slice(-4)}
        </p>
      )}
    </section>
  );
}
