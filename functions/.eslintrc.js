module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "google",
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json", "tsconfig.dev.json"],
    sourceType: "module",
  },
  ignorePatterns: [
    "/lib/**/*", // Ignore built files.
    "/generated/**/*", // Ignore generated files.
    "/scripts/**/*", // Ignore local migration helpers.
  ],
  plugins: [
    "@typescript-eslint",
    "import",
  ],
  rules: {
    "quotes": ["error", "double"],
    "import/no-unresolved": 0,
    "indent": ["error", 2],
  },
  overrides: [
    {
      files: ["src/mobile/**/*.ts"],
      rules: {
        "quotes": ["error", "single"],
        "object-curly-spacing": ["error", "always"],
        "max-len": ["error", {"code": 120}],
        "require-jsdoc": 0,
        "valid-jsdoc": 0,
        "operator-linebreak": 0,
        "quote-props": 0,
        "spaced-comment": 0,
      },
    },
  ],
};
