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
 * Content sanitisation utilities for proposal title/description (issue #320).
 *
 * Proposal titles and descriptions are stored on-chain and displayed in the
 * frontend.  Without sanitisation a malicious proposer could inject HTML that
 * renders in other users' browsers (stored XSS).
 *
 * Defence in depth:
 *   1. React JSX auto-escapes text nodes — but `dangerouslySetInnerHTML` or
 *      future code changes could bypass this.
 *   2. DOMPurify strips all HTML tags, leaving only plain text.
 *   3. CSP (Content Security Policy) blocks inline scripts even if sanitisation
 *      is bypassed.
 *
 * This module provides a single `sanitizeText` function that should be called
 * on any user-supplied string before it is rendered.
 */

import DOMPurify from 'dompurify';

/**
 * Sanitise a user-supplied string by stripping all HTML tags and attributes.
 *
 * Returns plain text with all HTML markup removed.  Safe to use in both
 * React JSX (as a text node) and in raw HTML contexts.
 *
 * @param value - The unsanitised string (e.g. proposal title or description).
 * @returns Sanitised plain text with no HTML tags.
 *
 * @example
 * const title = sanitizeText(proposal.title);
 * <h2>{title}</h2>
 */
export function sanitizeText(value: string): string {
  if (typeof value !== 'string') return '';
  // DOMPurify.sanitize with ALLOWED_TAGS: [] strips all tags, returning text only.
  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    ALLOW_DATA_ATTR: false,
  }) as string;
}

/**
 * Sanitise a proposal object's title and description in place.
 *
 * Convenience wrapper for components that receive a full proposal object.
 *
 * @param proposal - Object with `title` and `description` string properties.
 * @returns A new object with sanitised `title` and `description`.
 */
export function sanitizeProposal<T extends { title: string; description?: string }>(
  proposal: T,
): T {
  return {
    ...proposal,
    title: sanitizeText(proposal.title),
    description: proposal.description ? sanitizeText(proposal.description) : proposal.description,
  };
}
