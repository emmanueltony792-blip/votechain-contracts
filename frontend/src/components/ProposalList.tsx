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

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Proposal, ProposalState } from '../types';
import QuorumProgressBar from './QuorumProgressBar';
import { sanitizeText } from '../utils/sanitize';

const sortOptions = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'votes', label: 'Most votes' },
  { value: 'ending', label: 'Ending soon' }
] as const;

function labelForState(state: ProposalState) {
  return state;
}

function statusClass(state: ProposalState) {
  return `status-chip status-${state.toLowerCase()}`;
}

interface Props {
  proposals: Proposal[];
}

type StateFilter = 'All' | ProposalState;

type SortKey = (typeof sortOptions)[number]['value'];

export default function ProposalList({ proposals }: Props) {
  const [searchText, setSearchText] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('All');
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  const hasActiveFilters = searchText.trim() !== '' || stateFilter !== 'All';

  const filtered = useMemo(() => {
    const normalizedSearch = searchText.trim().toLowerCase();
    return proposals
      .filter((proposal) => {
        const matchesText = [proposal.title, proposal.description].some((value) =>
          value.toLowerCase().includes(normalizedSearch)
        );
        const matchesState = stateFilter === 'All' || proposal.state === stateFilter;
        return matchesText && matchesState;
      })
      .sort((a, b) => {
        if (sortKey === 'newest') {
          return b.createdAt.localeCompare(a.createdAt);
        }
        if (sortKey === 'oldest') {
          return a.createdAt.localeCompare(b.createdAt);
        }
        if (sortKey === 'votes') {
          return b.votesCount - a.votesCount;
        }
        return a.endAt.localeCompare(b.endAt);
      });
  }, [proposals, searchText, stateFilter, sortKey]);

  return (
    <section aria-labelledby="proposal-list-heading" className="card">
      <div className="header">
        <div>
          <h2 id="proposal-list-heading">Proposal listing</h2>
          <p>Search proposals by title or description, filter by state, and sort results instantly.</p>
        </div>
      </div>
      <div className="grid">
        <label>
          Search
          <input
            aria-label="Search proposals"
            type="search"
            value={searchText}
            placeholder="Search title or description"
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>
        <label>
          State
          <select
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value as StateFilter)}
          >
            <option value="All">All</option>
            <option value="Active">Active</option>
            <option value="Passed">Passed</option>
            <option value="Rejected">Rejected</option>
            <option value="Executed">Executed</option>
            <option value="Cancelled">Cancelled</option>
          </select>
        </label>
        <label>
          Sort by
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {filtered.length === 0 ? (
        <div className="proposal-empty-state" role="status" aria-live="polite">
          <svg className="proposal-empty-state__illustration" viewBox="0 0 80 80" aria-hidden="true">
            <rect x="14" y="12" width="52" height="56" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M25 27h30M25 38h18M25 52l7 7 15-16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h3>{hasActiveFilters ? 'No matching proposals' : 'No proposals yet'}</h3>
          <p>
            {hasActiveFilters
              ? 'Try changing your search or filters.'
              : 'There are no governance proposals to display.'}
          </p>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setSearchText('');
                setStateFilter('All');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="table-wrapper" aria-live="polite">
          <table>
            <caption className="visually-hidden">Filtered and sorted proposal listing</caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Title</th>
                <th scope="col">State</th>
                <th scope="col">Created</th>
                <th scope="col">End date</th>
                <th scope="col">Votes</th>
                <th scope="col">Weight</th>
                <th scope="col">Quorum</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((proposal) => (
                <tr key={proposal.id}>
                  <td>{proposal.id}</td>
                  <td>
                    <Link to={`/proposals/${proposal.id}`}>{sanitizeText(proposal.title)}</Link>
                  </td>
                  <td>
                    <span className={statusClass(proposal.state)}>{labelForState(proposal.state)}</span>
                  </td>
                  <td>{proposal.createdAt}</td>
                  <td>{proposal.endAt}</td>
                  <td>{proposal.votesCount}</td>
                  <td>{proposal.totalWeight}</td>
                  <td style={{ minWidth: '140px' }}>
                    <QuorumProgressBar
                      totalVotes={proposal.totalWeight}
                      quorum={proposal.quorum}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
