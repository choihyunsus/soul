// Soul v9.0 — ESLint flat config. Strict TypeScript rules for automated quality enforcement.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Security & Memory Leak Prevention ──
      '@typescript-eslint/no-floating-promises': 'error',    // fire-and-forget promise 방지
      '@typescript-eslint/no-misused-promises': 'error',     // Promise 오용 방지
      '@typescript-eslint/require-await': 'warn',            // 불필요 async 탐지

      // ── Type Safety ──
      '@typescript-eslint/no-explicit-any': 'error',         // any 사용 금지
      '@typescript-eslint/no-unsafe-assignment': 'warn',     // unsafe 할당 경고
      '@typescript-eslint/no-unsafe-member-access': 'warn',  // unsafe 멤버 접근 경고
      '@typescript-eslint/no-unsafe-call': 'warn',           // unsafe 호출 경고
      '@typescript-eslint/no-unsafe-return': 'warn',         // unsafe 반환 경고
      '@typescript-eslint/no-unsafe-argument': 'warn',       // unsafe 인자 경고

      // ── Code Hygiene ──
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],      // catch 빈 블록은 허용

      // ── Relaxed rules (strict preset overrides) ──
      '@typescript-eslint/restrict-template-expressions': 'off', // 템플릿 리터럴 유연하게
      '@typescript-eslint/no-unnecessary-condition': 'off',  // optional chaining 허용
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',         // delete activeSessions[project] 허용
      '@typescript-eslint/no-extraneous-class': 'off',       // class-based modules 허용
      '@typescript-eslint/unified-signatures': 'off',
      '@typescript-eslint/no-require-imports': 'off',        // 순환참조/optional 모듈용 require 허용
      '@typescript-eslint/require-await': 'off',             // MCP handler는 async 시그니처 필수
      '@typescript-eslint/no-non-null-assertion': 'warn',    // Record 인덱싱 시 필요 — 경고만
      '@typescript-eslint/no-base-to-string': 'warn',        // String() 변환 — 경고만 (warn 후 점진 수정)
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn', // 불필요 캐스팅 — 경고만
      '@typescript-eslint/no-unnecessary-type-parameters': 'off', // readJson<T> 패턴 허용
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'warn', // catch 콜백 → 점진 수정
    },
  },
  {
    // Test files: relax some rules
    files: ['src/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'data/', 'lib/', 'tools/', 'sequences/', '*.js'],
  },
);
