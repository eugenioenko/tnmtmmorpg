import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Math', message: 'Use world.rng() instead of Math.random' },
      ],
    },
  },
);
