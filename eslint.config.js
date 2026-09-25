/**
 * ESLint 扁平配置（flat config）
 *
 * 覆盖三层代码：
 *  - server/**       CommonJS，Node 环境
 *  - public/js/**    原生 ES Module，浏览器环境
 *  - tests/**        CommonJS，Node 环境 + 测试全局
 *
 * 目标：拦住真实事故（未定义变量、误用 const、忘 await 的明显陷阱），
 * 而不是制造大量风格噪音 —— 规则偏「排错」而非「美化」。
 */
const js = require('@eslint/js');

const COMMON_RULES = {
  // ---- 排错：未定义变量 / 未使用声明（重构后最常见的两类事故） ----
  'no-undef': 'error',
  'no-unused-vars': ['warn', {
    args: 'after-used',
    argsIgnorePattern: '^_|^next$',
    varsIgnorePattern: '^_|^__',
    caughtErrors: 'none',
  }],
  // ---- 明确有害的写法 ----
  'no-const-assign': 'error',
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'valid-typeof': 'error',
  'require-atomic-updates': 'off', // 与 express 回调风格冲突，误报多
  // ---- 一致性（保持项目现有风格，不强制格式化） ----
  'no-var': 'warn',
  'prefer-const': 'warn',
  eqeqeq: ['warn', 'smart'],
  'no-throw-literal': 'error',
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'warn',
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'public/vendor/**',
      '**/*.min.js',
    ],
  },

  // ---------- 服务端：CommonJS / Node ----------
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: COMMON_RULES,
  },

  // ---------- 前端：原生 ES Module / 浏览器 ----------
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        Headers: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        Image: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
        showSaveFilePicker: 'readonly',
        showOpenFilePicker: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        grecaptcha: 'readonly',
        turnstile: 'readonly',
      },
    },
    rules: COMMON_RULES,
  },

  // ---------- 测试：CommonJS / Node ----------
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
    rules: Object.assign({}, COMMON_RULES, {
      'no-unused-vars': 'off',
    }),
  },
];
