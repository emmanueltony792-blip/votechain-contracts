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

/**
 * Tests for ProposalList component (issue #11).
 * Covers: renders cards, search filter, state filter, sort, pagination.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ProposalList from './ProposalList';
import type { Proposal } from '../types';

// ── Fixtures ──────────────────────────────────────────────────

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'P-001',
    title: 'Test Proposal',
    description: 'A test description',
    state: 'Active',
    createdAt: '2026-01-01',
    endAt: '2026-02-01',
    votesCount: 10,
    totalWeight: 1000,
    votes: [],
    ...overrides,
  };
}

const proposals: Proposal[] = [
  makeProposal({ id: 'P-001', title: 'Alpha Proposal', state: 'Active',   createdAt: '2026-03-01', endAt: '2026-04-01', votesCount: 5,  totalWeight: 500  }),
  makeProposal({ id: 'P-002', title: 'Beta Proposal',  state: 'Passed',   createdAt: '2026-02-01', endAt: '2026-03-01', votesCount: 20, totalWeight: 2000 }),
  makeProposal({ id: 'P-003', title: 'Gamma Proposal', state: 'Rejected', createdAt: '2026-01-01', endAt: '2026-02-01', votesCount: 3,  totalWeight: 300  }),
];

// ── Render helpers ────────────────────────────────────────────

function renderList(props: Proposal[] = proposals) {
  return render(
    <MemoryRouter>
      <ProposalList proposals={props} />
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────

describe('ProposalList', () => {
  it('renders a row for each proposal', () => {
    renderList();
    expect(screen.getByText('Alpha Proposal')).toBeInTheDocument();
    expect(screen.getByText('Beta Proposal')).toBeInTheDocument();
    expect(screen.getByText('Gamma Proposal')).toBeInTheDocument();
  });

  it('renders an empty state when no proposals are passed', () => {
    renderList([]);
    expect(screen.getByRole('status')).toHaveTextContent(/no proposals yet/i);
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it('shows a filter empty state with a clear filters action', async () => {
    const user = userEvent.setup();
    renderList();

    await user.type(screen.getByRole('searchbox', { name: /search proposals/i }), 'missing');

    expect(screen.getByRole('status')).toHaveTextContent(/no matching proposals/i);
    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(screen.getByText('Alpha Proposal')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it('filters by search text (title match)', async () => {
    const user = userEvent.setup();
    renderList();

    const searchInput = screen.getByRole('searchbox', { name: /search proposals/i });
    await user.type(searchInput, 'alpha');

    expect(screen.getByText('Alpha Proposal')).toBeInTheDocument();
    expect(screen.queryByText('Beta Proposal')).not.toBeInTheDocument();
    expect(screen.queryByText('Gamma Proposal')).not.toBeInTheDocument();
  });

  it('filters by search text (description match)', async () => {
    const user = userEvent.setup();
    const custom = [
      makeProposal({ id: 'P-A', title: 'One', description: 'unique-keyword-here' }),
      makeProposal({ id: 'P-B', title: 'Two', description: 'something else' }),
    ];
    renderList(custom);

    const searchInput = screen.getByRole('searchbox', { name: /search proposals/i });
    await user.type(searchInput, 'unique-keyword');

    expect(screen.getByText('One')).toBeInTheDocument();
    expect(screen.queryByText('Two')).not.toBeInTheDocument();
  });

  it('filters by state', async () => {
    const user = userEvent.setup();
    renderList();

    const stateSelect = screen.getByLabelText(/^state$/i);
    await user.selectOptions(stateSelect, 'Passed');

    expect(screen.getByText('Beta Proposal')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Proposal')).not.toBeInTheDocument();
    expect(screen.queryByText('Gamma Proposal')).not.toBeInTheDocument();
  });

  it('shows all proposals when state filter is "All"', async () => {
    const user = userEvent.setup();
    renderList();

    const stateSelect = screen.getByLabelText(/^state$/i);
    await user.selectOptions(stateSelect, 'Passed');
    await user.selectOptions(stateSelect, 'All');

    expect(screen.getByText('Alpha Proposal')).toBeInTheDocument();
    expect(screen.getByText('Beta Proposal')).toBeInTheDocument();
    expect(screen.getByText('Gamma Proposal')).toBeInTheDocument();
  });

  it('sorts by newest (default — createdAt desc)', () => {
    renderList();
    const rows = screen.getAllByRole('row').slice(1); // skip header
    // P-001 is newest (2026-03-01), should appear first
    expect(within(rows[0]).getByText('Alpha Proposal')).toBeInTheDocument();
  });

  it('sorts by oldest (createdAt asc)', async () => {
    const user = userEvent.setup();
    renderList();

    const sortSelect = screen.getByLabelText(/sort by/i);
    await user.selectOptions(sortSelect, 'oldest');

    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('Gamma Proposal')).toBeInTheDocument();
  });

  it('sorts by most votes (votesCount desc)', async () => {
    const user = userEvent.setup();
    renderList();

    const sortSelect = screen.getByLabelText(/sort by/i);
    await user.selectOptions(sortSelect, 'votes');

    const rows = screen.getAllByRole('row').slice(1);
    // Beta has 20 votes — most
    expect(within(rows[0]).getByText('Beta Proposal')).toBeInTheDocument();
  });

  it('clears search and shows all proposals again', async () => {
    const user = userEvent.setup();
    renderList();

    const searchInput = screen.getByRole('searchbox', { name: /search proposals/i });
    await user.type(searchInput, 'alpha');
    await user.clear(searchInput);

    expect(screen.getByText('Alpha Proposal')).toBeInTheDocument();
    expect(screen.getByText('Beta Proposal')).toBeInTheDocument();
    expect(screen.getByText('Gamma Proposal')).toBeInTheDocument();
  });
});

// ── Security (issues #96, #320) ──────────────────────────────

describe('ProposalList XSS safety', () => {
  it('renders a malicious title as sanitised plain text, not executable HTML (#320)', () => {
    // Use a payload where DOMPurify strips the script tag but preserves
    // surrounding text so we can verify the text content survives.
    const payload = '<script>alert(1)</script>Clean Title';
    const { container } = renderList([
      makeProposal({ title: payload, description: '<img src=x onerror=alert(1)>' }),
    ]);
    // After sanitisation the <script> tag is stripped; "Clean Title" remains.
    expect(screen.getByText('Clean Title')).toBeInTheDocument();
    // No executable HTML elements should exist in the DOM.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
  });

  it('renders an onclick handler as inert text, not an executable element (#320)', () => {
    const { container } = renderList([
      makeProposal({ title: '<div onclick="alert(1)">Click me</div>' }),
    ]);
    // The onclick attribute must not appear anywhere in the DOM.
    expect(container.querySelector('[onclick]')).toBeNull();
    // The text content survives sanitisation.
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });
});
