import { readFileSync } from 'node:fs';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const styles = parse(readFileSync(new URL('../index.css', import.meta.url), 'utf8'));

describe('avatar presentation', () => {
  it('keeps every Fizzer profile-avatar surface circular after overrides', () => {
    for (const selector of [
      '.chat-avatar',
      '.sidebar-footer .user-avatar',
      '.account-avatar-preview',
      '.session-manager-avatar',
      '.account-avatar-preview img',
    ]) {
      let radius: string | undefined;
      styles.walkRules((rule) => {
        if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return;
        rule.walkDecls('border-radius', (declaration) => { radius = declaration.value; });
      });
      expect(radius, `${selector} final border-radius`).toBe('50%');
    }
  });
});
