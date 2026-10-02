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
        /**
         * R27-02：以下全局此前**缺失**，使 `no-undef` 产生 25 条误报、`npm run lint`
         * 长期恒红（30 errors），真实缺陷（`ops.js` 的 `currentItems`）被淹没在噪声里。
         * 名单仍是手工维护 —— 新增全局时请一并补到这里，否则门禁会重新变红。
         */
        ReadableStream: 'readonly',
        Blob: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        MessageChannel: 'readonly',
        performance: 'readonly',
        globalThis: 'readonly',
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
        /**
         * R27-02：补齐浏览器全局（含 `innerWidth` / `innerHeight` 这类挂在 window 上、
         * 但可在模块内以裸标识符访问的属性，以及 `XMLHttpRequest` / `btoa` / `atob` /
         * `Node` / `CanvasRenderingContext2D`）。缺一个就多一条 `no-undef` 误报 ——
         * 门禁恒红时，真缺陷与噪声无法区分。
         */
        XMLHttpRequest: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        scrollX: 'readonly',
        scrollY: 'readonly',
        Node: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        CanvasRenderingContext2D: 'readonly',
        Path2D: 'readonly',
        ImageData: 'readonly',
        ReadableStream: 'readonly',
        self: 'readonly',
        top: 'readonly',
        parent: 'readonly',
        history: 'readonly',
        screen: 'readonly',
        performance: 'readonly',
        globalThis: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        DOMParser: 'readonly',
        getSelection: 'readonly',
        scrollTo: 'readonly',
        createImageBitmap: 'readonly',
        OffscreenCanvas: 'readonly',
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
        // R27-02：测试进程同样运行在 Node 上，此处缺声明会让测试文件里的
        // `setImmediate` / `Response` / `AbortController` 变成 `no-undef` 误报。
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        AbortController: 'readonly',
        ReadableStream: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        Blob: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: Object.assign({}, COMMON_RULES, {
      'no-unused-vars': 'off',
    }),
  },
];
